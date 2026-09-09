// OpenVPN and lwIP exchange packets in memory; only authenticated CONNECT requests
// to the bootstrap allowlist enter the tunnel. Inherited stdin owns the lifetime.
#include <client/ovpncli.cpp>
#include <openvpn/tun/extern/config.hpp>
#include <openvpn/tun/builder/capture.hpp>
#include <json/json.h>
#include "lwip_stack.hpp"
#include <windows.h>
#include <array>
#include <deque>
#include <set>
#include <span>
#include <functional>
#include <limits>
#include <optional>

namespace {
using Tcp = openvpn_io::ip::tcp;
using Stack = dsh::vpn::LwipStack;
using Stream = dsh::vpn::Stream;

class Failure : public std::runtime_error {
public:
    explicit Failure(const char* code) : std::runtime_error(code) {}
};

void emit(Json::Value value) {
    Json::StreamWriterBuilder writer;
    writer["indentation"] = "";
    std::cout << Json::writeString(writer, value) << std::endl;
}

void status(const std::string& event, bool error = false) {
    Json::Value value;
    value["event"] = event;
    value["error"] = error;
    emit(std::move(value));
}

std::string required_text(const Json::Value& input, const char* field) {
    if (!input[field].isString() || input[field].asString().empty()) throw Failure("INVALID_BOOTSTRAP");
    const auto value = input[field].asString();
    if (value.find('\0') != std::string::npos) throw Failure("INVALID_BOOTSTRAP");
    return value;
}

std::string lower(std::string value) {
    for (char& ch : value) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    return value;
}

struct Target {
    std::string host;
    std::uint16_t port;
};

struct RuntimeConfig {
    std::vector<Target> targets;
    std::string proxy_token;
    std::size_t max_connections;
    std::chrono::milliseconds header_timeout;
    std::chrono::milliseconds target_connect_timeout;
    std::chrono::milliseconds poll_interval;
    std::size_t max_pending_packet_bytes;
};

unsigned int required_number(const Json::Value& input, const char* field,
                             unsigned int minimum, unsigned int maximum) {
    if (!input[field].isUInt()) throw Failure("INVALID_RUNTIME_CONFIG");
    const auto value = input[field].asUInt();
    if (value < minimum || value > maximum) throw Failure("INVALID_RUNTIME_CONFIG");
    return value;
}

RuntimeConfig read_runtime_config(const Json::Value& input) {
    RuntimeConfig config;
    config.proxy_token = required_text(input, "proxyToken");
    if (config.proxy_token.size() < 32 || config.proxy_token.size() > 256
        || config.proxy_token.find_first_of("\r\n") != std::string::npos)
        throw Failure("INVALID_PROXY_TOKEN");
    if (!input["targets"].isArray() || input["targets"].size() > 64)
        throw Failure("INVALID_TARGETS");
    std::set<std::pair<std::string, std::uint16_t>> unique;
    for (const auto& target : input["targets"]) {
        if (!target.isObject()) throw Failure("INVALID_TARGETS");
        auto host = lower(required_text(target, "host"));
        if (host.size() > 253 || host.find_first_of("\r\n\t /:@\\") != std::string::npos)
            throw Failure("INVALID_TARGET_HOST");
        const auto port = static_cast<std::uint16_t>(required_number(target, "port", 1, 65535));
        if (!unique.emplace(host, port).second) throw Failure("DUPLICATE_TARGET");
        config.targets.push_back({std::move(host), port});
    }
    config.max_connections = required_number(input, "maxConnections", 1, 32);
    config.header_timeout = std::chrono::milliseconds(required_number(input, "headerTimeoutMs", 100, 60000));
    config.target_connect_timeout = std::chrono::milliseconds(required_number(input, "targetConnectTimeoutMs", 100, 300000));
    config.poll_interval = std::chrono::milliseconds(required_number(input, "pollIntervalMs", 1, 1000));
    config.max_pending_packet_bytes = required_number(input, "maxPendingPacketBytes", 65536, 8388608);
    return config;
}

std::optional<Target> allowed_connect_target(const std::string& first_line,
                                           const std::vector<Target>& targets) {
    const auto request = lower(first_line);
    for (const auto& target : targets) {
        const auto expected = "connect " + target.host + ":" + std::to_string(target.port) + " http/1.1\r";
        if (request == expected) return target;
    }
    return std::nullopt;
}

class RelayConnection : public std::enable_shared_from_this<RelayConnection> {
public:
    RelayConnection(Tcp::socket socket, Stack& stack, const RuntimeConfig& config,
                    std::function<void(std::shared_ptr<RelayConnection>)> finished)
        : socket_(std::move(socket)), header_timeout_(socket_.get_executor()), stack_(stack),
          config_(config), finished_(std::move(finished)) {}

    void start() {
        const auto self = shared_from_this();
        header_timeout_.expires_after(config_.header_timeout);
        header_timeout_.async_wait([self](const std::error_code& error) {
            if (!error) self->stop();
        });
        openvpn_io::async_read_until(socket_, openvpn_io::dynamic_buffer(header_, 8192), "\r\n\r\n",
            [self](const std::error_code& error, std::size_t length) {
                if (self->stopped_) return;
                if (error) return self->stop();
                self->admit(length);
            });
    }

    void stop() {
        if (stopped_) return;
        stopped_ = true;
        header_timeout_.cancel();
        if (stream_) stream_->close();
        std::error_code ignored;
        socket_.close(ignored);
        auto finished = std::move(finished_);
        if (finished) finished(shared_from_this());
    }

private:
    struct PendingWrite { std::vector<std::uint8_t> bytes; std::size_t acknowledge; };
    Tcp::socket socket_;
    openvpn_io::steady_timer header_timeout_;
    Stack& stack_;
    RuntimeConfig config_;
    std::function<void(std::shared_ptr<RelayConnection>)> finished_;
    std::shared_ptr<Stream> stream_;
    std::string header_;
    std::array<std::uint8_t, 16384> read_buffer_{};
    std::vector<std::uint8_t> pending_send_;
    std::size_t send_offset_ = 0;
    std::deque<PendingWrite> writes_;
    bool writing_ = false;
    bool reading_ = false;
    bool peer_eof_ = false;
    bool stopped_ = false;

    void reject(int code) {
        peer_eof_ = true;
        const auto response = "HTTP/1.1 " + std::to_string(code) + " Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
        enqueue({reinterpret_cast<const std::uint8_t*>(response.data()), response.size()}, 0);
    }

    void admit(std::size_t length) {
        header_timeout_.cancel();
        std::istringstream headers(header_.substr(0, length));
        std::string first;
        std::getline(headers, first);
        const auto target = allowed_connect_target(first, config_.targets);
        if (!target) return reject(403);
        bool authenticated = false;
        bool seen_auth = false;
        std::string line;
        while (std::getline(headers, line) && line != "\r") {
            const auto colon = line.find(':');
            if (colon == std::string::npos) return reject(400);
            if (lower(line.substr(0, colon)) != "proxy-authorization") continue;
            if (seen_auth) return reject(400);
            seen_auth = true;
            const std::string supplied = line.substr(colon + 1);
            const std::string wanted = " Bearer " + config_.proxy_token + "\r";
            authenticated = supplied.size() == wanted.size()
                && CRYPTO_memcmp(supplied.data(), wanted.data(), wanted.size()) == 0;
        }
        if (!authenticated) return reject(407);
        if (length < header_.size()) {
            pending_send_.assign(header_.begin() + static_cast<std::ptrdiff_t>(length), header_.end());
        }
        header_.clear();
        auto weak = weak_from_this();
        Stream::Callbacks callbacks;
        callbacks.connected = [weak] {
            if (auto self = weak.lock(); self && !self->stopped_) {
                const std::string response = "HTTP/1.1 200 Connection Established\r\n\r\n";
                self->enqueue({reinterpret_cast<const std::uint8_t*>(response.data()), response.size()}, 0);
                self->flush_send();
            }
        };
        callbacks.received = [weak](std::span<const std::uint8_t> bytes) {
            if (auto self = weak.lock(); self && !self->stopped_) self->enqueue(bytes, bytes.size());
        };
        callbacks.writable = [weak] {
            if (auto self = weak.lock(); self && !self->stopped_) self->flush_send();
        };
        callbacks.closed = [weak](std::string error) {
            if (auto self = weak.lock(); self && !self->stopped_) {
                if (!error.empty()) return self->stop();
                self->peer_eof_ = true;
                if (self->writes_.empty()) self->stop();
            }
        };
        stream_ = stack_.connect(target->host, target->port, std::move(callbacks));
    }

    void enqueue(std::span<const std::uint8_t> bytes, std::size_t acknowledge) {
        writes_.push_back({std::vector<std::uint8_t>(bytes.begin(), bytes.end()), acknowledge});
        if (!writing_) write_next();
    }

    void write_next() {
        if (stopped_) return;
        if (writes_.empty()) {
            writing_ = false;
            if (peer_eof_) stop();
            return;
        }
        writing_ = true;
        const auto self = shared_from_this();
        openvpn_io::async_write(socket_, openvpn_io::buffer(writes_.front().bytes),
            [self](const std::error_code& error, std::size_t) {
                if (self->stopped_) return;
                if (error) return self->stop();
                const auto acknowledge = self->writes_.front().acknowledge;
                self->writes_.pop_front();
                if (acknowledge && self->stream_) self->stream_->consume_received(acknowledge);
                self->write_next();
            });
    }

    void flush_send() {
        if (stopped_ || !stream_) return;
        while (send_offset_ < pending_send_.size()) {
            const auto accepted = stream_->write(std::span(pending_send_).subspan(send_offset_));
            if (!accepted) return;
            send_offset_ += accepted;
        }
        pending_send_.clear();
        send_offset_ = 0;
        read_next();
    }

    void read_next() {
        if (stopped_ || reading_ || peer_eof_) return;
        reading_ = true;
        const auto self = shared_from_this();
        socket_.async_read_some(openvpn_io::buffer(read_buffer_),
            [self](const std::error_code& error, std::size_t length) {
                self->reading_ = false;
                if (self->stopped_) return;
                if (error) return self->stop();
                self->pending_send_.assign(self->read_buffer_.begin(), self->read_buffer_.begin() + length);
                self->flush_send();
            });
    }
};

class RelayServer : public std::enable_shared_from_this<RelayServer> {
public:
    RelayServer(openvpn_io::io_context& io, Stack& stack, RuntimeConfig config)
        : acceptor_(io, Tcp::endpoint(openvpn_io::ip::address_v4::loopback(), 0)), stack_(stack), config_(std::move(config)) {}
    std::uint16_t port() const { return acceptor_.local_endpoint().port(); }
    void start() { accept(); }
    void stop() {
        if (stopped_) return;
        stopped_ = true;
        std::error_code ignored;
        acceptor_.close(ignored);
        const auto connections = connections_;
        for (const auto& connection : connections) connection->stop();
    }
private:
    Tcp::acceptor acceptor_;
    Stack& stack_;
    RuntimeConfig config_;
    bool stopped_ = false;
    std::set<std::shared_ptr<RelayConnection>> connections_;
    void accept() {
        const auto self = shared_from_this();
        acceptor_.async_accept([self](const std::error_code& error, Tcp::socket socket) {
            if (self->stopped_) return;
            if (!error && self->connections_.size() < self->config_.max_connections) {
                const auto connection = std::make_shared<RelayConnection>(std::move(socket), self->stack_, self->config_,
                    [weak = self->weak_from_this()](std::shared_ptr<RelayConnection> done) {
                        if (auto owner = weak.lock()) owner->connections_.erase(done);
                    });
                self->connections_.insert(connection);
                connection->start();
            }
            if (!self->stopped_) self->accept();
        });
    }
};

struct MemoryNetwork {
    std::string address;
    std::string netmask;
    std::string gateway;
    std::vector<std::string> dns;
    std::uint16_t mtu;
};

MemoryNetwork resolve_memory_network(const openvpn::OptionList& options,
    const openvpn::ExternalTun::Config& config, openvpn::TunProp::State& state,
    const openvpn::IP::Addr& server_endpoint) {
    auto properties = config.tun_prop;
    if (properties.mtu == 0) properties.mtu = openvpn::TUN_MTU_DEFAULT;
    openvpn::TunBuilderCapture capture;
    openvpn::TunProp::configure_builder(&capture, &state, config.stats.get(),
        server_endpoint, properties, options, nullptr, true);
    if (capture.tunnel_address_index_ipv4 < 0 || capture.tunnel_address_index_ipv6 >= 0)
        throw Failure("UNSUPPORTED_IPV6_TUNNEL");
    const auto& address = capture.tunnel_addresses.at(capture.tunnel_address_index_ipv4);
    const auto prefix = address.prefix_length;
    if (prefix < 0 || prefix > 32) throw Failure("INVALID_TUNNEL_PREFIX");
    if (capture.mtu < 576 || capture.mtu > 9000) throw Failure("INVALID_TUNNEL_MTU");
    state.mtu = capture.mtu;
    const std::uint32_t mask = prefix == 0 ? 0 : (0xffffffffU << (32 - prefix));
    MemoryNetwork network;
    network.address = address.address;
    network.netmask = openvpn_io::ip::address_v4(mask).to_string();
    network.gateway = state.vpn_ip4_gw.defined() ? state.vpn_ip4_gw.to_string() : "0.0.0.0";
    network.mtu = static_cast<std::uint16_t>(capture.mtu);
    for (const auto& [priority, server] : capture.dns_options.servers) {
        if (server.transport != openvpn::DnsServer::Transport::Unset
            && server.transport != openvpn::DnsServer::Transport::Plain)
            throw Failure("UNSUPPORTED_DNS_TRANSPORT");
        if (server.dnssec == openvpn::DnsServer::Security::Yes)
            throw Failure("UNSUPPORTED_REQUIRED_DNSSEC");
        for (const auto& entry : server.addresses) {
            if (entry.port != 0 && entry.port != 53) throw Failure("UNSUPPORTED_DNS_PORT");
            if (entry.address.find(':') == std::string::npos) network.dns.push_back(entry.address);
        }
    }
    return network;
}

class MemoryTun : public openvpn::TunClient {
public:
    MemoryTun(openvpn_io::io_context& io, openvpn::TunClientParent& parent,
              openvpn::ExternalTun::Config config, RuntimeConfig runtime)
        : io_(io), parent_(parent), config_(std::move(config)), runtime_(std::move(runtime)), timer_(io) {}

    ~MemoryTun() override { stop(); }

    void tun_start(const openvpn::OptionList& options, openvpn::TransportClient& transport,
                   openvpn::CryptoDCSettings&) override {
        const auto network = resolve_memory_network(options, config_, state_, transport.server_endpoint_addr());
        stack_ = std::make_unique<Stack>([this](std::span<const std::uint8_t> packet) {
            if (stopped_) return;
            if (packet.size() > runtime_.max_pending_packet_bytes - pending_packet_bytes_) throw Failure("PACKET_QUEUE_FULL");
            auto buffer = std::make_shared<openvpn::BufferAllocated>();
            config_.frame->prepare(openvpn::Frame::READ_TUN, *buffer);
            buffer->write(packet.data(), packet.size());
            pending_packet_bytes_ += packet.size();
            const openvpn::TunClient::Ptr keep_alive(this);
            openvpn_io::post(io_, [this, keep_alive, buffer] {
                pending_packet_bytes_ -= buffer->size();
                if (stopped_) return;
                config_.stats->inc_stat(openvpn::SessionStats::TUN_BYTES_IN, buffer->size());
                config_.stats->inc_stat(openvpn::SessionStats::TUN_PACKETS_IN, 1);
                parent_.tun_recv(*buffer);
            });
        }, Stack::Options{runtime_.max_connections, runtime_.target_connect_timeout});
        stack_->configure(network.address, network.netmask, network.gateway, network.dns, network.mtu);
        relay_ = std::make_shared<RelayServer>(io_, *stack_, runtime_);
        relay_->start();
        schedule();
        parent_.tun_connected();
        Json::Value ready;
        ready["event"] = "proxy-ready";
        ready["error"] = false;
        ready["port"] = relay_->port();
        ready["dnsConfigured"] = !network.dns.empty();
        emit(std::move(ready));
    }

    bool tun_send(openvpn::BufferAllocated& buffer) override {
        if (stopped_ || !stack_) return false;
        stack_->input({buffer.data(), buffer.size()});
        config_.stats->inc_stat(openvpn::SessionStats::TUN_BYTES_OUT, buffer.size());
        config_.stats->inc_stat(openvpn::SessionStats::TUN_PACKETS_OUT, 1);
        return true;
    }
    void stop() override {
        if (stopped_) return;
        stopped_ = true;
        timer_.cancel();
        if (relay_) relay_->stop();
        if (stack_) stack_->shutdown();
    }
    void apply_push_update(const openvpn::OptionList&, openvpn::TransportClient&) override {
        if (stopped_) return;
        stop();
        constexpr auto code = "NETWORK_UPDATE_REQUIRES_RESTART";
        status(code, true);
        parent_.tun_error(openvpn::Error::TUN_HALT, code);
    }
    void set_disconnect() override {}
    std::string tun_name() const override { return "dsh-memory-ipv4"; }
    std::string vpn_ip4() const override { return state_.vpn_ip4_addr.to_string(); }
    std::string vpn_ip6() const override { return {}; }
    int vpn_mtu() const override { return state_.mtu; }
private:
    openvpn_io::io_context& io_;
    openvpn::TunClientParent& parent_;
    openvpn::ExternalTun::Config config_;
    RuntimeConfig runtime_;
    openvpn::TunProp::State state_;
    openvpn_io::steady_timer timer_;
    std::unique_ptr<Stack> stack_;
    std::shared_ptr<RelayServer> relay_;
    bool stopped_ = false;
    std::size_t pending_packet_bytes_ = 0;
    void schedule() {
        timer_.expires_after(runtime_.poll_interval);
        const openvpn::TunClient::Ptr keep_alive(this);
        timer_.async_wait([this, keep_alive](const std::error_code& error) {
            if (error || stopped_) return;
            stack_->poll_timers();
            schedule();
        });
    }
};

class MemoryTunFactory : public openvpn::TunClientFactory {
public:
    MemoryTunFactory(openvpn::ExternalTun::Config config, RuntimeConfig runtime)
        : config_(std::move(config)), runtime_(std::move(runtime)) {}
    openvpn::TunClient::Ptr new_tun_client_obj(openvpn_io::io_context& io,
        openvpn::TunClientParent& parent, openvpn::TransportClient*) override {
        if (created_) throw Failure("RECONNECT_REQUIRES_RESTART");
        created_ = true;
        return new MemoryTun(io, parent, config_, runtime_);
    }
    bool supports_epoch_data() override { return true; }
private:
    openvpn::ExternalTun::Config config_;
    RuntimeConfig runtime_;
    bool created_ = false;
};

class Client : public openvpn::ClientAPI::OpenVPNClient {
public:
    explicit Client(RuntimeConfig runtime) : runtime_(std::move(runtime)) {}
    bool failed() const { return failed_; }
    openvpn::TunClientFactory* new_tun_factory(const openvpn::ExternalTun::Config& config,
                                             const openvpn::OptionList&) override {
        return new MemoryTunFactory(config, runtime_);
    }
    bool socket_protect(openvpn_io::detail::socket_type, std::string, bool) override { return true; }
    bool pause_on_connection_timeout() override { return false; }
    void event(const openvpn::ClientAPI::Event& event) override {
        status(event.name, event.error);
        if (event.name == "RECONNECTING" || event.error) {
            failed_ = true;
            stop();
        }
    }
    void acc_event(const openvpn::ClientAPI::AppCustomControlMessageEvent&) override {}
    void log(const openvpn::ClientAPI::LogInfo&) override {}
    void external_pki_cert_request(openvpn::ClientAPI::ExternalPKICertRequest& request) override {
        request.error = true;
        request.errorText = "External PKI is not supported by this helper";
    }
    void external_pki_sign_request(openvpn::ClientAPI::ExternalPKISignRequest& request) override {
        request.error = true;
        request.errorText = "External PKI is not supported by this helper";
    }
    void clock_tick() override {
        DWORD available = 0;
        const auto input = GetStdHandle(STD_INPUT_HANDLE);
        if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) {
            stop();
            return;
        }
        if (available) {
            // Any subsequent input is a shutdown request; bootstrap is the only configuration message.
            stop();
        }
    }
private:
    RuntimeConfig runtime_;
    bool failed_ = false;
};

Json::Value read_bootstrap() {
    const auto input_pipe = GetStdHandle(STD_INPUT_HANDLE);
    if (GetFileType(input_pipe) != FILE_TYPE_PIPE) throw Failure("BOOTSTRAP_REQUIRES_PARENT_PIPE");
    std::string line;
    char ch;
    DWORD count = 0;
    while (ReadFile(input_pipe, &ch, 1, &count, nullptr) && count == 1) {
        if (ch == '\n') break;
        if (line.size() >= 1048576) throw Failure("BOOTSTRAP_TOO_LARGE");
        line.push_back(ch);
    }
    Json::CharReaderBuilder builder;
    builder["rejectDupKeys"] = true;
    builder["failIfExtra"] = true;
    builder["allowComments"] = false;
    Json::Value input;
    std::string errors;
    const auto reader = std::unique_ptr<Json::CharReader>(builder.newCharReader());
    if (!reader->parse(line.data(), line.data() + line.size(), &input, &errors) || !input.isObject())
        throw Failure("INVALID_BOOTSTRAP");
    return input;
}
} // namespace

int main() {
    try {
        auto input = read_bootstrap();
        if (input.isMember("evaluateOnly") && !input["evaluateOnly"].isBool())
            throw Failure("INVALID_BOOTSTRAP");
        openvpn::ClientAPI::OpenVPNClientHelper helper;
        const auto merged = helper.merge_config_string(required_text(input, "profileContent"));
        if (merged.status != "MERGE_SUCCESS") throw Failure("PROFILE_IMPORT_FAILED");
        if (!merged.refPathList.empty()) throw Failure("PROFILE_REQUIRES_INLINE_FILES");
        openvpn::ClientAPI::Config config;
        config.content = merged.profileContent;
        const auto profile_options = openvpn::OptionList::parse_from_config_static(config.content, nullptr);
        config.disableClientCert = !profile_options.exists("cert")
            && !profile_options.exists("key") && !profile_options.exists("pkcs12");
        config.clockTickMS = 100;
        config.retryOnAuthFailed = false;
        config.googleDnsFallback = false;
        config.tunPersist = false;
        const auto evaluated = helper.eval_config(config);
        Json::Value summary;
        summary["event"] = "profile-evaluated";
        summary["accepted"] = !evaluated.error;
        summary["error"] = evaluated.error;
        summary["requiresUserPassword"] = !evaluated.autologin;
        summary["requiresChallenge"] = !evaluated.staticChallenge.empty();
        summary["requiresPrivateKeyPassword"] = evaluated.privateKeyPasswordRequired;
        summary["requiresExternalPki"] = evaluated.externalPki && !config.disableClientCert;
        summary["externalReferenceCount"] = static_cast<Json::UInt>(merged.refPathList.size());
        emit(std::move(summary));
        if (evaluated.error) throw Failure("PROFILE_REJECTED_BY_OPENVPN3");
        if (input.get("evaluateOnly", false).asBool()) return 0;
        if (!evaluated.staticChallenge.empty() || evaluated.privateKeyPasswordRequired
            || (evaluated.externalPki && !config.disableClientCert)) throw Failure("UNSUPPORTED_AUTHENTICATION");
        config.connTimeout = required_number(input, "connectTimeoutSeconds", 1, 300);
        Client client(read_runtime_config(input));
        if (client.eval_config(config).error) throw Failure("PROFILE_REJECTED_BY_OPENVPN3");
        openvpn::ClientAPI::ProvideCreds credentials;
        credentials.username = required_text(input, "username");
        credentials.password = required_text(input, "password");
        if (client.provide_creds(credentials).error) throw Failure("CREDENTIALS_REJECTED");
        input.removeMember("password");
        input.removeMember("username");
        credentials.password.clear();
        const auto result = client.connect();
        const bool failed = result.error || client.failed();
        status(failed ? "connection-failed" : "stopped", failed);
        return failed ? 2 : 0;
    } catch (const Failure& error) {
        status(error.what(), true);
        return 2;
    } catch (const std::exception&) {
        status("NATIVE_FAILURE", true);
        return 2;
    }
}

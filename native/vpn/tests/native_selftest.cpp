#define main dsh_vpn_helper_main
#include "../src/main.cpp"
#undef main

namespace {
using Packet = std::vector<std::uint8_t>;

void require_native(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

openvpn::OptionList network_options(const std::string& text) {
    openvpn::OptionList options;
    options.parse_from_config(text, nullptr);
    options.update_map();
    return options;
}

MemoryNetwork resolve_fixture(const std::string& text, int configured_mtu,
                              openvpn::TunProp::State& state, int maximum_mtu = 1600) {
    openvpn::ExternalTun::Config config;
    config.tun_prop.mtu = configured_mtu;
    config.tun_prop.mtu_max = maximum_mtu;
    return resolve_memory_network(network_options(text), config, state,
        openvpn::IP::Addr::from_string("203.0.113.1"));
}

std::uint16_t packet_u16(const Packet& packet, std::size_t offset) {
    return static_cast<std::uint16_t>((packet.at(offset) << 8) | packet.at(offset + 1));
}

std::uint16_t advertised_mss(const Packet& packet) {
    const std::size_t ip_length = (packet.at(0) & 15) * 4;
    const std::size_t tcp_length = (packet.at(ip_length + 12) >> 4) * 4;
    for (std::size_t index = ip_length + 20; index < ip_length + tcp_length;) {
        const auto kind = packet.at(index);
        if (kind == 0) break;
        if (kind == 1) { ++index; continue; }
        const auto length = packet.at(index + 1);
        require_native(length >= 2, "TCP option length must be valid");
        if (kind == 2 && length == 4) return packet_u16(packet, index + 2);
        index += length;
    }
    throw std::runtime_error("TCP SYN must advertise an MSS");
}

void verify_packet_output(const MemoryNetwork& network) {
    std::vector<Packet> packets;
    Stack stack([&packets](auto bytes) { packets.emplace_back(bytes.begin(), bytes.end()); });
    stack.configure(network.address, network.netmask, network.gateway, network.dns, network.mtu);
    std::string error;
    Stream::Callbacks callbacks;
    callbacks.received = [](auto) {};
    callbacks.closed = [&error](std::string message) { error = std::move(message); };
    auto stream = stack.connect("198.51.100.80", 443, callbacks);
    require_native(packets.empty(), "Connect must remain deferred until the poll");
    stack.poll_timers();
    require_native(error.empty(), "Parsed VPN network must admit an off-subnet TCP connection");
    const auto syn = std::find_if(packets.begin(), packets.end(), [](const Packet& packet) {
        const std::size_t ip_length = (packet.at(0) & 15) * 4;
        return packet.at(9) == 6 && (packet.at(ip_length + 13) & 2) != 0;
    });
    require_native(syn != packets.end(), "TCP SYN must leave the in-memory VPN interface");
    const auto address = openvpn_io::ip::make_address_v4(network.address).to_bytes();
    require_native(std::equal(address.begin(), address.end(), syn->begin() + 12),
        "TCP source address must match the pushed ifconfig address");
    require_native(advertised_mss(*syn) == std::min<int>(1460, network.mtu - 40),
        "The resolved VPN MTU must constrain the advertised TCP MSS");
    stream->close();

    if (!network.dns.empty()) {
        packets.clear();
        auto dns_stream = stack.connect("internal.example.test", 443, callbacks);
        stack.poll_timers();
        require_native(error.empty(), "Parsed VPN DNS must admit an internal lookup");
        const auto query = std::find_if(packets.begin(), packets.end(), [](const Packet& packet) {
            return packet.at(9) == 17 && packet_u16(packet, (packet.at(0) & 15) * 4 + 2) == 53;
        });
        require_native(query != packets.end(), "An internal hostname must emit a DNS query into the tunnel");
        const auto dns_address = openvpn_io::ip::make_address_v4(network.dns.front()).to_bytes();
        require_native(std::equal(dns_address.begin(), dns_address.end(), query->begin() + 16),
            "DNS query destination must match the pushed DNS server");
        dns_stream->close();
    }
    stack.shutdown();
    const auto stopped_count = packets.size();
    stack.poll_timers();
    require_native(packets.size() == stopped_count, "Shutdown must suppress further tunnel output");
}

template<class Action>
void require_failure(Action action, const char* code) {
    try { action(); }
    catch (const Failure& failure) {
        require_native(std::string(failure.what()) == code, "Network rejection must identify the expected failure");
        return;
    }
    throw std::runtime_error("Invalid tunnel configuration must be rejected");
}

void invalid_networks() {
    const std::string subnet = "topology subnet\nifconfig 10.18.0.2 255.255.255.0\n";
    const std::string dns = "dns server 0 address 10.18.0.53\n";
    for (const auto transport : {"DoH", "DoT"}) {
        require_failure([&] {
            openvpn::TunProp::State state;
            resolve_fixture(subnet + dns + "dns server 0 transport " + transport + "\n", 0, state);
        }, "UNSUPPORTED_DNS_TRANSPORT");
    }
    require_failure([&] {
        openvpn::TunProp::State state;
        resolve_fixture(subnet + dns + "dns server 0 dnssec yes\n", 0, state);
    }, "UNSUPPORTED_REQUIRED_DNSSEC");
    {
        openvpn::TunProp::State state;
        const auto network = resolve_fixture(subnet + dns + "dns server 0 transport plain\n", 0, state);
        require_native(network.dns == std::vector<std::string>{"10.18.0.53"},
            "Explicit classic DNS must be retained");
    }
    require_failure([&] {
        openvpn::TunProp::State state;
        resolve_fixture(subnet + "ifconfig-ipv6 fd00::2/64 fd00::1\n", 0, state);
    }, "UNSUPPORTED_IPV6_TUNNEL");
    require_failure([&] {
        openvpn::TunProp::State state;
        resolve_fixture(subnet + "tun-mtu 575\n", 0, state);
    }, "INVALID_TUNNEL_MTU");
    require_failure([&] {
        openvpn::TunProp::State state;
        resolve_fixture(subnet, 9500, state, 9600);
    }, "INVALID_TUNNEL_MTU");
}

struct UpdateParent final : openvpn::TunClientParent {
    openvpn::Error::Type error = openvpn::Error::UNDEF;
    std::string message;
    int notifications = 0;
    void tun_recv(openvpn::BufferAllocated&) override { throw std::runtime_error("Unexpected update packet"); }
    void tun_error(openvpn::Error::Type code, const std::string& text) override {
        error = code;
        message = text;
        ++notifications;
    }
    void tun_pre_tun_config() override {}
    void tun_pre_route_config() override {}
    void tun_connected() override {}
};

struct UnusedTransport final : openvpn::TransportClient {
    [[noreturn]] static void unexpected() { throw std::runtime_error("Rejecting a network update must not use transport"); }
    void transport_start() override { unexpected(); }
    void stop() override { unexpected(); }
    bool transport_send_const(const openvpn::Buffer&) override { unexpected(); }
    bool transport_send(openvpn::BufferAllocated&) override { unexpected(); }
    bool transport_send_queue_empty() override { unexpected(); }
    bool transport_has_send_queue() override { unexpected(); }
    void transport_stop_requeueing() override { unexpected(); }
    std::size_t transport_send_queue_size() override { unexpected(); }
    void reset_align_adjust(std::size_t) override { unexpected(); }
    openvpn::IP::Addr server_endpoint_addr() const override { unexpected(); }
    void server_endpoint_info(std::string&, std::string&, std::string&, std::string&) const override { unexpected(); }
    openvpn::Protocol transport_protocol() const override { unexpected(); }
    void transport_reparent(openvpn::TransportClientParent*) override { unexpected(); }
};

void reject_network_update() {
    openvpn_io::io_context io;
    UpdateParent parent;
    UnusedTransport transport;
    MemoryTun tun(io, parent, {}, RuntimeConfig{});
    const auto options = network_options("dhcp-option DNS 10.18.0.54\n");
    tun.apply_push_update(options, transport);
    require_native(parent.error == openvpn::Error::TUN_HALT,
        "Unsupported network updates must halt the OpenVPN session");
    require_native(parent.message == "NETWORK_UPDATE_REQUIRES_RESTART",
        "Network update rejection must use its sanitized restart code");
    tun.apply_push_update(options, transport);
    require_native(parent.notifications == 1, "A stopped tunnel must not repeat update failures");
    io.poll();
}

void verify_connect_allowlist() {
    const std::vector<Target> targets{{"first.example.test", 443}, {"second.example.test", 80}};
    require_native(allowed_connect_target("CONNECT FIRST.EXAMPLE.TEST:443 HTTP/1.1\r", targets).has_value(),
        "CONNECT must match a configured hostname case-insensitively");
    const auto second = allowed_connect_target("CONNECT second.example.test:80 HTTP/1.1\r", targets);
    require_native(second && second->host == "second.example.test" && second->port == 80,
        "CONNECT must select the corresponding host and port from the allowlist");
    require_native(!allowed_connect_target("CONNECT first.example.test:80 HTTP/1.1\r", targets),
        "An unconfigured host-port combination must be denied");
    require_native(!allowed_connect_target("CONNECT unknown.example.test:443 HTTP/1.1\r", targets),
        "An unknown host must be denied");
    require_native(!allowed_connect_target("CONNECT first.example.test:443 HTTP/1.1\r", {}),
        "An empty allowlist must deny every destination");
}

void verify_proxy_admission() {
    openvpn_io::io_context io;
    std::vector<Packet> packets;
    Stack stack([&](auto bytes) { packets.emplace_back(bytes.begin(), bytes.end()); });
    stack.configure("10.18.0.2", "255.255.255.0", "0.0.0.0", {}, 1500);
    const std::string token(64, 'a');
    RuntimeConfig config{{{"198.51.100.80", 443}}, token, 2, std::chrono::milliseconds(100),
        std::chrono::milliseconds(30000), std::chrono::milliseconds(10), 1048576};
    auto relay = std::make_shared<RelayServer>(io, stack, config);
    relay->start();
    const Tcp::endpoint endpoint(openvpn_io::ip::address_v4::loopback(), relay->port());
    auto rejected = [&](const std::string& request, const std::string& expected) {
        Tcp::socket client(io);
        client.connect(endpoint);
        openvpn_io::write(client, openvpn_io::buffer(request));
        std::string response;
        bool closed = false;
        bool timed_out = false;
        openvpn_io::steady_timer deadline(io, std::chrono::seconds(2));
        deadline.async_wait([&](const std::error_code& error) { if (!error) timed_out = true; });
        openvpn_io::async_read(client, openvpn_io::dynamic_buffer(response, 16384),
            [&](const std::error_code& error, std::size_t) {
                closed = error == openvpn_io::error::eof || error == openvpn_io::error::connection_reset;
            });
        while (!closed && !timed_out) io.run_one();
        deadline.cancel();
        client.close();
        io.poll();
        require_native(closed && !timed_out, "Rejected proxy requests must close within their admission deadline");
        require_native(expected.empty() ? response.empty() : response.starts_with(expected),
            "Proxy admission must return the expected rejection status");
        stack.poll_timers();
        require_native(packets.empty(), "Rejected proxy requests must not emit tunnel traffic");
    };
    const std::string allowed = "CONNECT 198.51.100.80:443 HTTP/1.1\r\n";
    const std::string auth = "Proxy-Authorization: Bearer " + token + "\r\n";
    rejected(allowed + "\r\n", "HTTP/1.1 407");
    rejected(allowed + "Proxy-Authorization: Bearer wrong\r\n\r\n", "HTTP/1.1 407");
    rejected(allowed + auth + auth + "\r\n", "HTTP/1.1 400");
    rejected("CONNECT 198.51.100.80:80 HTTP/1.1\r\n" + auth + "\r\n", "HTTP/1.1 403");
    rejected("CONNECT other.example.test:443 HTTP/1.1\r\n" + auth + "\r\n", "HTTP/1.1 403");
    rejected("GET http://198.51.100.80/ HTTP/1.1\r\n" + auth + "\r\n", "HTTP/1.1 403");
    rejected(allowed + "X-Incomplete: ", "");
    rejected(allowed + "X-Oversized: " + std::string(8300, 'x'), "");

    Tcp::socket accepted(io);
    accepted.connect(endpoint);
    const auto request = allowed + auth + "\r\n";
    openvpn_io::write(accepted, openvpn_io::buffer(request));
    bool timed_out = false;
    openvpn_io::steady_timer deadline(io, std::chrono::seconds(2));
    deadline.async_wait([&](const std::error_code& error) { if (!error) timed_out = true; });
    openvpn_io::steady_timer tick(io);
    std::function<void()> poll = [&] {
        stack.poll_timers();
        if (!packets.empty() || timed_out) return;
        tick.expires_after(std::chrono::milliseconds(5));
        tick.async_wait([&](const std::error_code& error) { if (!error) poll(); });
    };
    poll();
    while (packets.empty() && !timed_out) io.run_one();
    deadline.cancel();
    tick.cancel();
    accepted.close();
    relay->stop();
    stack.shutdown();
    io.poll();
    require_native(!timed_out && !packets.empty(), "Authenticated configured destinations must enter the tunnel");
    require_native(packets.front().at(9) == 6, "Admitted CONNECT must emit a TCP packet into the in-memory network");
}
}

int main(int argc, char** argv) {
    try {
        require_native(argc == 2, "Specify one native network fixture per process");
        const std::string mode = argv[1];
        if (mode == "invalid") {
            invalid_networks();
        } else if (mode == "network-update") {
            reject_network_update();
        } else if (mode == "connect-allowlist") {
            verify_connect_allowlist();
        } else if (mode == "proxy-admission") {
            verify_proxy_admission();
        } else {
            openvpn::TunProp::State state;
            MemoryNetwork network;
            if (mode == "subnet-default") {
                network = resolve_fixture("topology subnet\nifconfig 10.18.0.2 255.255.255.0\n", 0, state);
                require_native(network.mtu == 1500, "Omitted MTU must use the OpenVPN default 1500");
                require_native(network.gateway == "0.0.0.0", "A subnet tunnel without route-gateway must have no IP gateway");
                require_native(network.netmask == "255.255.255.0", "Subnet topology must retain its prefix");
            } else if (mode == "subnet-configured-mtu") {
                network = resolve_fixture("topology subnet\nifconfig 10.18.0.2 255.255.255.0\nroute-gateway 10.18.0.1\n", 1400, state);
                require_native(network.mtu == 1400, "A configured MTU must survive absent pushed tun-mtu");
                require_native(network.gateway == "10.18.0.1", "A pushed subnet gateway must be retained");
            } else if (mode == "net30") {
                network = resolve_fixture("topology net30\nifconfig 10.18.0.2 10.18.0.1\ntun-mtu 1380\ndhcp-option DNS 10.18.0.53\n", 0, state);
                require_native(network.mtu == 1380, "A pushed MTU must override the default");
                require_native(network.netmask == "255.255.255.252", "Net30 must produce a /30 netmask");
                require_native(network.gateway == "10.18.0.1", "Net30 must retain the point-to-point peer");
                require_native(network.dns == std::vector<std::string>{"10.18.0.53"}, "Pushed DNS must be retained");
            } else {
                throw std::runtime_error("Unknown native fixture");
            }
            require_native(state.mtu == network.mtu, "OpenVPN state must expose the resolved MTU");
            verify_packet_output(network);
        }
        std::cout << "PASS native network " << mode << '\n';
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL native network: " << error.what() << '\n';
        return 1;
    }
}

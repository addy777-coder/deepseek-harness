#include "lwip_stack.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <stdexcept>
#include <thread>
#include <utility>

#include <openssl/rand.h>

extern "C" {
#include "lwip/dns.h"
#include "lwip/init.h"
#include "lwip/ip4.h"
#include "lwip/netif.h"
#include "lwip/pbuf.h"
#include "lwip/tcp.h"
#include "lwip/timeouts.h"

u32_t sys_now(void) {
    const auto elapsed = std::chrono::steady_clock::now().time_since_epoch();
    return static_cast<u32_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count());
}

uint32_t dsh_lwip_rand(void) {
    uint32_t value = 0;
    if (RAND_bytes(reinterpret_cast<unsigned char*>(&value), sizeof(value)) != 1) std::abort();
    return value;
}

void dsh_lwip_assert(void) {
    std::fputs("lwIP invariant failure\n", stderr);
    std::abort();
}
}

namespace dsh::vpn::detail {

struct StreamState;

// lwIP has no DNS cancellation API. Stable process-lifetime tickets retain only
// weak stream references, so late DNS responses cannot call a disposed consumer.
struct DnsTicket {
    bool busy = false;
    std::weak_ptr<StreamState> stream;
};

static std::array<DnsTicket, DNS_MAX_REQUESTS> dns_tickets;
static std::atomic<bool> stack_constructed{false};
static_assert(DNS_MAX_REQUESTS == DNS_TABLE_SIZE,
              "Pinned lwIP DNS cleanup indexes dns_table with the request-array bound");

enum class Phase { queued, resolving, connecting, connected, peer_eof, closed };

static const char* tcp_error(err_t error) noexcept {
    switch (error) {
    case ERR_MEM: return "VPN TCP memory limit reached";
    case ERR_BUF: return "VPN TCP buffer limit reached";
    case ERR_TIMEOUT: return "VPN TCP connection timed out";
    case ERR_RTE: return "VPN TCP route is unavailable";
    case ERR_ABRT: return "VPN TCP connection was aborted";
    case ERR_RST: return "VPN TCP connection was reset";
    case ERR_CLSD: return "VPN TCP connection closed";
    case ERR_CONN: return "VPN TCP connection is unavailable";
    case ERR_IF: return "VPN packet transport failed";
    default: return "VPN TCP operation failed";
    }
}

struct StackCore {
    LwipStack::Output output;
    LwipStack::Options options;
    std::thread::id thread = std::this_thread::get_id();
    netif interface{};
    bool configured = false;
    bool stopped = false;
    bool output_failed = false;
    bool processing = false;
    bool has_dns = false;
    std::vector<std::weak_ptr<StreamState>> streams;
    std::vector<std::weak_ptr<StreamState>> pending;

    StackCore(LwipStack::Output packet_output, LwipStack::Options resolved_options)
        : output(std::move(packet_output)), options(resolved_options) {
        if (!output || options.max_streams == 0 || options.max_streams > 32 ||
            options.connect_timeout <= std::chrono::milliseconds::zero()) {
            throw std::invalid_argument("Invalid lwIP stack options");
        }
        if (stack_constructed.exchange(true)) {
            throw std::logic_error("Only one lwIP stack may be created per helper process");
        }
        lwip_init();
    }

    void require_thread() const {
        if (std::this_thread::get_id() != thread) {
            throw std::logic_error("lwIP must run on its creating thread");
        }
    }

    static err_t initialize_netif(netif* interface) noexcept {
        interface->name[0] = 'v';
        interface->name[1] = 'p';
        interface->output = &output_packet;
        interface->hwaddr_len = 0;
        interface->flags = 0;
        return ERR_OK;
    }

    static err_t output_packet(netif* interface, pbuf* packet, const ip4_addr_t*) noexcept {
        auto& core = *static_cast<StackCore*>(interface->state);
        if (core.stopped || core.output_failed) return ERR_IF;
        try {
            std::vector<std::uint8_t> bytes(packet->tot_len);
            if (pbuf_copy_partial(packet, bytes.data(), packet->tot_len, 0) != packet->tot_len) {
                core.output_failed = true;
                return ERR_IF;
            }
            core.output(bytes);
            return ERR_OK;
        } catch (...) {
            core.output_failed = true;
            return ERR_IF;
        }
    }

    void prune();
};

struct StreamState : std::enable_shared_from_this<StreamState> {
    StackCore* owner;
    std::thread::id thread;
    std::string host;
    std::uint16_t port;
    Stream::Callbacks callbacks;
    std::chrono::steady_clock::time_point deadline;
    tcp_pcb* pcb = nullptr;
    DnsTicket* dns_ticket = nullptr;
    Phase phase = Phase::queued;
    std::size_t unconsumed = 0;
    std::uint64_t abort_count = 0;

    StreamState(StackCore& stack, std::string destination, std::uint16_t destination_port,
                Stream::Callbacks consumer)
        : owner(&stack), thread(stack.thread), host(std::move(destination)),
          port(destination_port), callbacks(std::move(consumer)),
          deadline(std::chrono::steady_clock::now() + stack.options.connect_timeout) {}

    void require_thread() const {
        if (std::this_thread::get_id() != thread) {
            throw std::logic_error("VPN streams must run on the lwIP thread");
        }
    }

    static void detach(tcp_pcb* connection) noexcept {
        tcp_arg(connection, nullptr);
        tcp_recv(connection, nullptr);
        tcp_sent(connection, nullptr);
        tcp_err(connection, nullptr);
        tcp_poll(connection, nullptr, 0);
    }

    void cancel() noexcept {
        if (std::this_thread::get_id() != thread) std::terminate();
        callbacks = {};
        phase = Phase::closed;
        if (dns_ticket) {
            dns_ticket->stream.reset();
            dns_ticket = nullptr;
        }
        if (pcb) {
            auto* connection = std::exchange(pcb, nullptr);
            detach(connection);
            ++abort_count;
            tcp_abort(connection);
        }
        owner = nullptr;
    }

    void fail(const char* error) noexcept {
        auto closed = std::move(callbacks.closed);
        cancel();
        if (closed) {
            try {
                closed(std::string(error));
            } catch (...) {
                std::fputs("VPN close callback failed\n", stderr);
            }
        }
    }

    template<class Callback, class... Args>
    void deliver(Callback& callback, Args&&... args) noexcept {
        if (!callback) return;
        try {
            // A callback can synchronously close its own stream, which clears the
            // stored function. The local copy keeps that invocation alive.
            auto invocation = callback;
            invocation(std::forward<Args>(args)...);
        } catch (...) {
            fail("VPN stream callback failed");
        }
    }

    void start() noexcept {
        if (phase != Phase::queued) return;
        if (!owner || !owner->configured || owner->stopped) {
            fail("VPN IPv4 tunnel is not configured");
            return;
        }
        if (port == 0 || host.empty() || host.size() >= DNS_MAX_NAME_LENGTH ||
            host.find('\0') != std::string::npos) {
            fail("Invalid VPN TCP destination");
            return;
        }
        if (host.find(':') != std::string::npos) {
            fail("The VPN helper supports IPv4 destinations only");
            return;
        }
        ip_addr_t address{};
        if (ipaddr_aton(host.c_str(), &address)) {
            begin_tcp(address);
            return;
        }
        if (!owner->has_dns) {
            fail("VPN did not supply an IPv4 DNS server");
            return;
        }
        for (auto& ticket : dns_tickets) {
            if (!ticket.busy) {
                ticket.busy = true;
                ticket.stream = weak_from_this();
                dns_ticket = &ticket;
                break;
            }
        }
        if (!dns_ticket) {
            fail("VPN DNS request limit reached");
            return;
        }
        phase = Phase::resolving;
        const auto result = dns_gethostbyname_addrtype(host.c_str(), &address,
            &dns_complete, dns_ticket, LWIP_DNS_ADDRTYPE_IPV4);
        if (result == ERR_INPROGRESS) return;
        dns_ticket->busy = false;
        dns_ticket->stream.reset();
        dns_ticket = nullptr;
        if (result == ERR_OK) begin_tcp(address);
        else fail("VPN DNS lookup could not start");
    }

    static void dns_complete(const char*, const ip_addr_t* address, void* argument) noexcept {
        auto& ticket = *static_cast<DnsTicket*>(argument);
        auto stream = ticket.stream.lock();
        ticket.stream.reset();
        ticket.busy = false;
        if (!stream || stream->phase != Phase::resolving) return;
        stream->dns_ticket = nullptr;
        if (address) stream->begin_tcp(*address);
        else stream->fail("VPN DNS lookup failed");
    }

    void begin_tcp(const ip_addr_t& address) noexcept {
        if (ip_addr_isany(&address) || ip_addr_ismulticast(&address) ||
            ip4_addr_isloopback(ip_2_ip4(&address))) {
            fail("VPN destination must be a unicast IPv4 address");
            return;
        }
        pcb = tcp_new_ip_type(IPADDR_TYPE_V4);
        if (!pcb) {
            fail("VPN TCP stream limit reached");
            return;
        }
        tcp_bind_netif(pcb, &owner->interface);
        tcp_arg(pcb, this);
        tcp_recv(pcb, &received);
        tcp_sent(pcb, &sent);
        tcp_err(pcb, &errored);
        tcp_poll(pcb, &polled, 2);
        tcp_nagle_disable(pcb);
        phase = Phase::connecting;
        const auto result = tcp_connect(pcb, &address, port, &connected);
        if (result != ERR_OK) fail(tcp_error(result));
    }

    void close_after_drain() noexcept {
        if (phase != Phase::peer_eof || unconsumed != 0 || !pcb) return;
        auto* connection = std::exchange(pcb, nullptr);
        detach(connection);
        phase = Phase::closed;
        owner = nullptr;
        if (tcp_close(connection) != ERR_OK) {
            ++abort_count;
            tcp_abort(connection);
        }
    }

    void peer_eof() noexcept {
        phase = Phase::peer_eof;
        auto closed = std::move(callbacks.closed);
        callbacks = {};
        close_after_drain();
        if (closed) {
            try {
                closed({});
            } catch (...) {
                cancel();
                std::fputs("VPN close callback failed\n", stderr);
            }
        }
    }

    static err_t connected(void* argument, tcp_pcb*, err_t error) noexcept {
        auto stream = static_cast<StreamState*>(argument)->shared_from_this();
        const auto aborted = stream->abort_count;
        if (error != ERR_OK) stream->fail(tcp_error(error));
        else {
            stream->phase = Phase::connected;
            stream->deliver(stream->callbacks.connected);
        }
        return stream->abort_count != aborted ? ERR_ABRT : ERR_OK;
    }

    static err_t received(void* argument, tcp_pcb*, pbuf* packet, err_t error) noexcept {
        auto stream = static_cast<StreamState*>(argument)->shared_from_this();
        const auto aborted = stream->abort_count;
        if (error != ERR_OK) {
            if (packet) pbuf_free(packet);
            stream->fail(tcp_error(error));
        } else if (!packet) {
            stream->peer_eof();
        } else {
            try {
                std::vector<std::uint8_t> bytes(packet->tot_len);
                if (pbuf_copy_partial(packet, bytes.data(), packet->tot_len, 0) != packet->tot_len) {
                    throw std::runtime_error("VPN TCP receive copy failed");
                }
                pbuf_free(packet);
                packet = nullptr;
                stream->unconsumed += bytes.size();
                stream->deliver(stream->callbacks.received,
                                std::span<const std::uint8_t>(bytes));
            } catch (...) {
                if (packet) pbuf_free(packet);
                stream->fail("VPN TCP receive buffer allocation failed");
            }
        }
        return stream->abort_count != aborted ? ERR_ABRT : ERR_OK;
    }

    static err_t sent(void* argument, tcp_pcb*, u16_t) noexcept {
        auto stream = static_cast<StreamState*>(argument)->shared_from_this();
        const auto aborted = stream->abort_count;
        if (stream->phase == Phase::connected) stream->deliver(stream->callbacks.writable);
        return stream->abort_count != aborted ? ERR_ABRT : ERR_OK;
    }

    static err_t polled(void* argument, tcp_pcb*) noexcept {
        auto stream = static_cast<StreamState*>(argument)->shared_from_this();
        const auto aborted = stream->abort_count;
        if (stream->phase == Phase::connected) stream->deliver(stream->callbacks.writable);
        return stream->abort_count != aborted ? ERR_ABRT : ERR_OK;
    }

    static void errored(void* argument, err_t error) noexcept {
        if (!argument) return;
        auto stream = static_cast<StreamState*>(argument)->shared_from_this();
        // lwIP has already freed the pcb before calling its error handler.
        stream->pcb = nullptr;
        stream->fail(tcp_error(error));
    }
};

void StackCore::prune() {
    std::erase_if(streams, [](const auto& entry) {
        auto stream = entry.lock();
        return !stream || stream->phase == Phase::closed;
    });
}

struct ProcessingGuard {
    StackCore& core;
    explicit ProcessingGuard(StackCore& stack) : core(stack) {
        if (core.processing) throw std::logic_error("lwIP packet input cannot be recursive");
        core.processing = true;
    }
    ~ProcessingGuard() { core.processing = false; }
};

} // namespace dsh::vpn::detail

namespace dsh::vpn {

Stream::Stream(std::shared_ptr<detail::StreamState> state) : state_(std::move(state)) {}
Stream::~Stream() { close(); }

std::size_t Stream::write(std::span<const std::uint8_t> bytes) {
    auto state = state_;
    state->require_thread();
    if (state->phase != detail::Phase::connected || bytes.empty()) return 0;
    const auto available = static_cast<std::size_t>(tcp_sndbuf(state->pcb));
    auto accepted = std::min(bytes.size(), available);
    if (accepted == 0) return 0;
    err_t result;
    // An exhausted segment pool can reject a full send-buffer write while still
    // admitting a smaller chunk. Bound retries by halving that same chunk.
    do {
        result = tcp_write(state->pcb, bytes.data(), static_cast<u16_t>(accepted), TCP_WRITE_FLAG_COPY);
        if (result != ERR_MEM) break;
        accepted /= 2;
    } while (accepted != 0);
    if (accepted == 0) return 0;
    if (result != ERR_OK) {
        state->fail(detail::tcp_error(result));
        return 0;
    }
    result = tcp_output(state->pcb);
    if (result != ERR_OK && result != ERR_MEM && result != ERR_BUF) {
        state->fail(detail::tcp_error(result));
        return 0;
    }
    return accepted;
}

void Stream::consume_received(std::size_t count) {
    auto state = state_;
    state->require_thread();
    if (count > state->unconsumed) {
        throw std::logic_error("VPN receive credit exceeds delivered bytes");
    }
    state->unconsumed -= count;
    if (!state->pcb || count == 0) return;
    while (count != 0) {
        const auto chunk = static_cast<u16_t>(std::min<std::size_t>(count, 65535));
        tcp_recved(state->pcb, chunk);
        count -= chunk;
    }
    state->close_after_drain();
}

void Stream::close() noexcept { state_->cancel(); }

LwipStack::LwipStack(Output output) : LwipStack(std::move(output), Options{}) {}
LwipStack::LwipStack(Output output, Options options)
    : impl_(std::make_unique<detail::StackCore>(std::move(output), options)) {}
LwipStack::~LwipStack() { shutdown(); }

void LwipStack::configure(const std::string& address, const std::string& netmask,
                         const std::string& gateway, const std::vector<std::string>& dns,
                         std::uint16_t mtu) {
    auto& core = *impl_;
    core.require_thread();
    if (core.configured || core.stopped) {
        throw std::logic_error("VPN IPv4 tunnel configuration is immutable");
    }
    if (mtu < 576 || mtu > 9000 || dns.size() > DNS_MAX_SERVERS) {
        throw std::invalid_argument("Unsupported VPN MTU or DNS server count");
    }
    ip4_addr_t local{}, mask{}, next_hop{};
    if (!ip4addr_aton(address.c_str(), &local) || ip4_addr_isany_val(local) ||
        ip4_addr_ismulticast(&local) || ip4_addr_isloopback(&local) ||
        !ip4addr_aton(netmask.c_str(), &mask) ||
        !ip4_addr_netmask_valid(mask.addr) ||
        !ip4addr_aton(gateway.c_str(), &next_hop)) {
        throw std::invalid_argument("Invalid VPN IPv4 tunnel configuration");
    }
    std::array<ip_addr_t, DNS_MAX_SERVERS> servers{};
    for (std::size_t index = 0; index < dns.size(); ++index) {
        if (!ipaddr_aton(dns[index].c_str(), &servers[index]) ||
            ip_addr_isany(&servers[index]) || ip_addr_ismulticast(&servers[index]) ||
            ip4_addr_isloopback(ip_2_ip4(&servers[index]))) {
            throw std::invalid_argument("VPN DNS server must be a unicast IPv4 address");
        }
    }
    if (!netif_add(&core.interface, &local, &mask, &next_hop, &core,
                   &detail::StackCore::initialize_netif, &ip4_input)) {
        throw std::runtime_error("Could not create in-memory VPN network interface");
    }
    core.interface.mtu = mtu;
    netif_set_default(&core.interface);
    for (u8_t index = 0; index < DNS_MAX_SERVERS; ++index) dns_setserver(index, &servers[index]);
    core.has_dns = !dns.empty();
    core.configured = true;
    netif_set_link_up(&core.interface);
    netif_set_up(&core.interface);
}

std::shared_ptr<Stream> LwipStack::connect(std::string host, std::uint16_t port,
                                         Stream::Callbacks callbacks) {
    auto& core = *impl_;
    core.require_thread();
    if (core.stopped) throw std::logic_error("VPN stack has been shut down");
    if (!callbacks.received) throw std::invalid_argument("VPN stream requires a receive callback");
    core.prune();
    if (core.streams.size() >= core.options.max_streams) {
        throw std::runtime_error("VPN concurrent stream limit reached");
    }
    auto state = std::make_shared<detail::StreamState>(core, std::move(host), port,
                                                     std::move(callbacks));
    auto stream = std::shared_ptr<Stream>(new Stream(state));
    core.streams.emplace_back(state);
    core.pending.emplace_back(state);
    return stream;
}

void LwipStack::input(std::span<const std::uint8_t> packet) {
    auto& core = *impl_;
    core.require_thread();
    if (core.stopped) return;
    if (!core.configured) throw std::logic_error("VPN IPv4 tunnel is not configured");
    if (packet.empty() || (packet.front() >> 4) != 4) {
        throw std::invalid_argument("VPN helper accepts raw IPv4 packets only");
    }
    if (packet.size() < 20 || packet.size() > std::numeric_limits<u16_t>::max()) {
        throw std::invalid_argument("Invalid VPN IPv4 packet length");
    }
    detail::ProcessingGuard processing(core);
    auto* buffer = pbuf_alloc(PBUF_RAW, static_cast<u16_t>(packet.size()), PBUF_POOL);
    if (!buffer) throw std::runtime_error("VPN packet receive pool is exhausted");
    if (pbuf_take(buffer, packet.data(), static_cast<u16_t>(packet.size())) != ERR_OK) {
        pbuf_free(buffer);
        throw std::runtime_error("Could not copy VPN IPv4 packet");
    }
    const auto result = core.interface.input(buffer, &core.interface);
    if (result != ERR_OK) pbuf_free(buffer);
    if (core.output_failed) throw std::runtime_error("VPN packet output failed");
}

void LwipStack::poll_timers() {
    auto& core = *impl_;
    core.require_thread();
    if (core.stopped) return;
    detail::ProcessingGuard processing(core);
    auto pending = std::move(core.pending);
    core.pending.clear();
    for (auto& entry : pending) {
        if (auto stream = entry.lock()) stream->start();
    }
    if (core.stopped) return;
    sys_check_timeouts();
    if (core.stopped) return;
    const auto now = std::chrono::steady_clock::now();
    auto streams = core.streams;
    for (auto& entry : streams) {
        if (auto stream = entry.lock(); stream && stream->phase != detail::Phase::connected &&
            stream->phase != detail::Phase::peer_eof && stream->phase != detail::Phase::closed &&
            now >= stream->deadline) {
            stream->fail("VPN TCP connection timed out");
        }
    }
    core.prune();
    if (core.output_failed) throw std::runtime_error("VPN packet output failed");
}

void LwipStack::shutdown() noexcept {
    auto& core = *impl_;
    if (std::this_thread::get_id() != core.thread) std::terminate();
    if (core.stopped) return;
    core.stopped = true;
    // Stop packet output before cancellation can produce TCP reset packets.
    if (core.configured) {
        netif_set_down(&core.interface);
        netif_set_link_down(&core.interface);
        netif_remove(&core.interface);
    }
    for (auto& entry : core.streams) {
        if (auto stream = entry.lock()) stream->cancel();
    }
    core.streams.clear();
    core.pending.clear();
    core.output = {};
}

} // namespace dsh::vpn

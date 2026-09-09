#include "lwip_stack.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <deque>
#include <iostream>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

using Bytes = std::vector<std::uint8_t>;
using Address = std::array<std::uint8_t, 4>;
constexpr Address client_address{10, 18, 0, 2};
constexpr Address server_address{10, 19, 0, 7};
constexpr Address dns_address{10, 18, 0, 53};

void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

template<class Action>
void requires_throw(Action action, const char* message) {
    bool caught = false;
    try { action(); } catch (const std::exception&) { caught = true; }
    require(caught, message);
}

std::uint16_t get16(std::span<const std::uint8_t> data, std::size_t offset) {
    return static_cast<std::uint16_t>((data[offset] << 8) | data[offset + 1]);
}

std::uint32_t get32(std::span<const std::uint8_t> data, std::size_t offset) {
    return (std::uint32_t(data[offset]) << 24) | (std::uint32_t(data[offset + 1]) << 16) |
           (std::uint32_t(data[offset + 2]) << 8) | data[offset + 3];
}

void set16(Bytes& data, std::size_t offset, std::uint16_t value) {
    data[offset] = static_cast<std::uint8_t>(value >> 8);
    data[offset + 1] = static_cast<std::uint8_t>(value);
}

void set32(Bytes& data, std::size_t offset, std::uint32_t value) {
    set16(data, offset, static_cast<std::uint16_t>(value >> 16));
    set16(data, offset + 2, static_cast<std::uint16_t>(value));
}

std::uint16_t checksum(std::span<const std::uint8_t> bytes) {
    std::uint32_t sum = 0;
    std::size_t index = 0;
    for (; index + 1 < bytes.size(); index += 2) sum += get16(bytes, index);
    if (index != bytes.size()) sum += std::uint16_t(bytes[index]) << 8;
    while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
    return static_cast<std::uint16_t>(~sum);
}

Bytes ip_packet(Address source, Address destination, std::uint8_t protocol, Bytes payload) {
    Bytes result(20 + payload.size());
    result[0] = 0x45;
    set16(result, 2, static_cast<std::uint16_t>(result.size()));
    result[8] = 64;
    result[9] = protocol;
    std::copy(source.begin(), source.end(), result.begin() + 12);
    std::copy(destination.begin(), destination.end(), result.begin() + 16);
    set16(result, 10, checksum(std::span(result).first(20)));
    std::copy(payload.begin(), payload.end(), result.begin() + 20);
    return result;
}

Bytes tcp_packet(std::uint16_t local_port, std::uint32_t sequence,
                 std::uint32_t acknowledged, std::uint8_t flags,
                 std::span<const std::uint8_t> payload = {}) {
    Bytes tcp(20 + payload.size());
    set16(tcp, 0, 443);
    set16(tcp, 2, local_port);
    set32(tcp, 4, sequence);
    set32(tcp, 8, acknowledged);
    tcp[12] = 0x50;
    tcp[13] = flags;
    set16(tcp, 14, 65535);
    std::copy(payload.begin(), payload.end(), tcp.begin() + 20);
    Bytes pseudo(12 + tcp.size());
    std::copy(server_address.begin(), server_address.end(), pseudo.begin());
    std::copy(client_address.begin(), client_address.end(), pseudo.begin() + 4);
    pseudo[9] = 6;
    set16(pseudo, 10, static_cast<std::uint16_t>(tcp.size()));
    std::copy(tcp.begin(), tcp.end(), pseudo.begin() + 12);
    set16(tcp, 16, checksum(pseudo));
    return ip_packet(server_address, client_address, 6, std::move(tcp));
}

Bytes dns_answer(const Bytes& request) {
    require(request.size() >= 40 && request[9] == 17, "DNS request must use UDP");
    require(std::equal(dns_address.begin(), dns_address.end(), request.begin() + 16),
            "DNS request must use the configured VPN DNS server");
    const std::size_t ip_length = (request[0] & 15) * 4;
    const auto query = std::span(request).subspan(ip_length + 8);
    require(get16(query, 4) == 1, "DNS query must contain one question");
    Bytes dns(query.begin(), query.end());
    set16(dns, 2, 0x8180);
    set16(dns, 6, 1);
    const std::array<std::uint8_t, 16> answer{
        0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4,
        server_address[0], server_address[1], server_address[2], server_address[3]};
    dns.insert(dns.end(), answer.begin(), answer.end());
    Bytes udp(8 + dns.size());
    set16(udp, 0, 53);
    set16(udp, 2, get16(request, ip_length));
    set16(udp, 4, static_cast<std::uint16_t>(udp.size()));
    // IPv4 permits a zero UDP checksum. TCP fixture packets always carry checksums.
    std::copy(dns.begin(), dns.end(), udp.begin() + 8);
    return ip_packet(dns_address, client_address, 17, std::move(udp));
}

struct Fixture {
    std::deque<Bytes> packets;
    dsh::vpn::LwipStack stack{[this](auto bytes) {
        packets.emplace_back(bytes.begin(), bytes.end());
    }};

    template<class Predicate>
    Bytes take(Predicate matches, const char* message) {
        auto found = std::find_if(packets.begin(), packets.end(), matches);
        require(found != packets.end(), message);
        Bytes result = std::move(*found);
        packets.erase(found);
        return result;
    }

    Bytes take_syn() {
        return take([](const Bytes& packet) {
            return packet[9] == 6 && (packet[(packet[0] & 15) * 4 + 13] & 2) != 0;
        }, "TCP SYN must leave the in-memory interface");
    }

    Bytes take_dns() {
        return take([](const Bytes& packet) {
            return packet[9] == 17 && get16(packet, (packet[0] & 15) * 4 + 2) == 53;
        }, "DNS query must leave the in-memory interface");
    }

    static std::size_t payload_offset(const Bytes& packet) {
        const auto ip_length = (packet[0] & 15) * 4;
        return ip_length + (packet[ip_length + 12] >> 4) * 4;
    }
};

void numeric_tcp(Fixture& fixture) {
    bool connected = false;
    std::string received;
    std::string error;
    int closed = 0;
    int writable = 0;
    auto stream = fixture.stack.connect("10.19.0.7", 443, {
        [&] { connected = true; },
        [&](auto bytes) { received.append(reinterpret_cast<const char*>(bytes.data()), bytes.size()); },
        [&] { ++writable; },
        [&](auto message) { ++closed; error = std::move(message); }
    });
    require(fixture.packets.empty() && !connected, "Connect must defer until poll_timers");
    fixture.stack.poll_timers();
    auto syn = fixture.take_syn();
    require(std::equal(client_address.begin(), client_address.end(), syn.begin() + 12),
            "TCP source address must be the VPN-assigned address");
    const auto ip_length = (syn[0] & 15) * 4;
    const auto port = get16(syn, ip_length);
    const auto initial_sequence = get32(syn, ip_length + 4);
    constexpr std::uint32_t peer_sequence = 91000;
    fixture.stack.input(tcp_packet(port, peer_sequence, initial_sequence + 1, 0x12));
    require(connected && closed == 0, "Valid SYN-ACK must establish the stream");
    fixture.packets.clear();

    Bytes payload(70000);
    for (std::size_t index = 0; index < payload.size(); ++index) payload[index] = index % 251;
    const auto accepted = stream->write(payload);
    require(accepted > 0 && accepted <= 65535, "Send memory must be bounded");
    require(stream->write(payload) == 0, "A full send queue must apply backpressure");
    std::size_t acknowledged = 0;
    while (acknowledged < accepted) {
        auto data = fixture.take([](const auto& packet) {
            return packet[9] == 6 && packet.size() > Fixture::payload_offset(packet);
        }, "TCP data must make progress as the peer acknowledges it");
        const auto offset = Fixture::payload_offset(data);
        const auto count = data.size() - offset;
        const auto header = (data[0] & 15) * 4;
        require(get32(data, header + 4) == initial_sequence + 1 + acknowledged,
                "TCP segments must preserve stream ordering");
        require(std::equal(data.begin() + offset, data.end(), payload.begin() + acknowledged),
                "TCP output bytes must match accepted input bytes");
        acknowledged += count;
        fixture.stack.input(tcp_packet(port, peer_sequence + 1,
            initial_sequence + 1 + static_cast<std::uint32_t>(acknowledged), 0x10));
    }
    require(writable > 0, "TCP acknowledgments must return writable credit");
    fixture.packets.clear();

    const std::array<std::uint8_t, 3> response{'a', 'b', 'c'};
    fixture.stack.input(tcp_packet(port, peer_sequence + 1,
        initial_sequence + 1 + static_cast<std::uint32_t>(accepted), 0x18, response));
    require(received == "abc", "Peer payload must reach the receive callback");
    requires_throw([&] { stream->consume_received(4); }, "Receive credit must reject undelivered bytes");
    stream->consume_received(2);
    fixture.stack.input(tcp_packet(port, peer_sequence + 4,
        initial_sequence + 1 + static_cast<std::uint32_t>(accepted), 0x11));
    require(closed == 1 && error.empty(), "Peer FIN must report EOF exactly once");
    stream->consume_received(1);
    require(std::none_of(fixture.packets.begin(), fixture.packets.end(), [](const auto& packet) {
        return packet[9] == 6 && (packet[(packet[0] & 15) * 4 + 13] & 4) != 0;
    }), "Draining received bytes must close gracefully without RST");
    stream->close();
    require(closed == 1, "Explicit close must not duplicate the peer EOF callback");
    fixture.packets.clear();
}

void dns_and_cancel(Fixture& fixture) {
    int cancelled_callbacks = 0;
    auto cancelled = fixture.stack.connect("cancelled.model.test", 443, {
        [&] { ++cancelled_callbacks; }, [](auto) {}, {}, [&](auto) { ++cancelled_callbacks; }
    });
    fixture.stack.poll_timers();
    auto request = fixture.take_dns();
    cancelled->close();
    cancelled.reset();
    fixture.stack.input(dns_answer(request));
    require(cancelled_callbacks == 0 && fixture.packets.empty(),
            "Late DNS completion must not revive a cancelled stream");

    bool connected = false;
    auto stream = fixture.stack.connect("model.test", 443, {
        [&] { connected = true; }, [](auto) {}, {}, [](auto) {}
    });
    fixture.stack.poll_timers();
    request = fixture.take_dns();
    fixture.stack.input(dns_answer(request));
    auto syn = fixture.take_syn();
    require(std::equal(server_address.begin(), server_address.end(), syn.begin() + 16),
            "TCP must connect to the address resolved through VPN DNS");
    const auto offset = (syn[0] & 15) * 4;
    fixture.stack.input(tcp_packet(get16(syn, offset), 92000, get32(syn, offset + 4) + 1, 0x12));
    require(connected, "VPN DNS result must support a TCP connection");
    stream->close();
    fixture.packets.clear();
}

void callback_failure(Fixture& fixture) {
    int closed = 0;
    std::string error;
    auto stream = fixture.stack.connect("10.19.0.7", 443, {
        {}, [](auto) { throw std::runtime_error("consumer failed"); }, {},
        [&](auto value) { ++closed; error = std::move(value); }
    });
    fixture.stack.poll_timers();
    auto syn = fixture.take_syn();
    const auto offset = (syn[0] & 15) * 4;
    const auto port = get16(syn, offset);
    const auto acknowledgment = get32(syn, offset + 4) + 1;
    fixture.stack.input(tcp_packet(port, 93000, acknowledgment, 0x12));
    const std::array<std::uint8_t, 1> data{'x'};
    fixture.stack.input(tcp_packet(port, 93001, acknowledgment, 0x18, data));
    require(closed == 1 && error == "VPN stream callback failed",
            "Consumer exceptions must close the stream without crossing lwIP callbacks");
    stream->close();
    fixture.packets.clear();
}

void callback_cancellation(Fixture& fixture) {
    int connected = 0;
    int closed = 0;
    std::shared_ptr<dsh::vpn::Stream> stream;
    stream = fixture.stack.connect("10.19.0.7", 443, {
        [&] { ++connected; stream.reset(); }, [](auto) {}, {}, [&](auto) { ++closed; }
    });
    fixture.stack.poll_timers();
    auto syn = fixture.take_syn();
    const auto offset = (syn[0] & 15) * 4;
    fixture.stack.input(tcp_packet(get16(syn, offset), 94000, get32(syn, offset + 4) + 1, 0x12));
    require(connected == 1 && closed == 0 && !stream,
            "A callback must be able to destroy its own stream without a stale pcb callback");
    fixture.packets.clear();
}

void rejected_destinations_and_limits(Fixture& fixture) {
    std::string error;
    auto ipv6 = fixture.stack.connect("2001:db8::1", 443, {
        {}, [](auto) {}, {}, [&](auto value) { error = std::move(value); }
    });
    fixture.stack.poll_timers();
    require(error == "The VPN helper supports IPv4 destinations only" && fixture.packets.empty(),
            "IPv6 destinations must fail before attempting traffic");
    Bytes ipv6_packet(40);
    ipv6_packet[0] = 0x60;
    requires_throw([&] { fixture.stack.input(ipv6_packet); },
                   "IPv6 data-channel packets must fail explicitly");
    std::vector<std::shared_ptr<dsh::vpn::Stream>> admitted;
    for (int index = 0; index < 16; ++index) {
        admitted.push_back(fixture.stack.connect("10.19.0.7", 443, {{}, [](auto) {}, {}, {}}));
    }
    requires_throw([&] {
        fixture.stack.connect("10.19.0.7", 443, {{}, [](auto) {}, {}, {}});
    }, "Concurrent stream admission must enforce the configured bound");
    admitted.clear();
    fixture.stack.poll_timers();
    require(fixture.packets.empty(), "Cancelled queued streams must not start network work");
}

void no_host_dns(Fixture& fixture) {
    std::string error;
    auto stream = fixture.stack.connect("unresolved.model.test", 443, {
        {}, [](auto) {}, {}, [&](auto value) { error = std::move(value); }
    });
    fixture.stack.poll_timers();
    require(error == "VPN did not supply an IPv4 DNS server",
            "Missing VPN DNS must fail explicitly");
    require(fixture.packets.empty(), "Missing VPN DNS must not produce direct fallback traffic");
}

void quiescence(Fixture& fixture) {
    int callbacks = 0;
    auto stream = fixture.stack.connect("shutdown.model.test", 443, {
        [&] { ++callbacks; }, [&](auto) { ++callbacks; }, {}, [&](auto) { ++callbacks; }
    });
    fixture.stack.poll_timers();
    auto response = dns_answer(fixture.take_dns());
    fixture.stack.shutdown();
    fixture.stack.input(response);
    fixture.stack.poll_timers();
    stream->close();
    require(callbacks == 0 && fixture.packets.empty(),
            "Stack shutdown must suppress packet output and all consumer callbacks");
}

} // namespace

int main(int argc, char** argv) {
    try {
        Fixture fixture;
        const bool without_dns = argc == 2 && std::string_view(argv[1]) == "--no-dns";
        requires_throw([&] {
            fixture.stack.configure("10.18.0.2", "255.255.255.0", "10.18.0.1", {}, 100);
        }, "Unsupported MTU must be rejected");
        fixture.stack.configure("10.18.0.2", "255.255.255.0", "10.18.0.1",
            without_dns ? std::vector<std::string>{} : std::vector<std::string>{"10.18.0.53"});
        if (without_dns) {
            no_host_dns(fixture);
            std::cout << "PASS: absent VPN DNS fails without a host resolver fallback\n";
        } else {
            numeric_tcp(fixture);
            dns_and_cancel(fixture);
            callback_failure(fixture);
            callback_cancellation(fixture);
            rejected_destinations_and_limits(fixture);
            quiescence(fixture);
            std::cout << "PASS: synthetic IPv4 TCP data, send/receive credit, DNS, cancellation, EOF, callback containment, admission limits, IPv6 rejection, shutdown\n";
        }
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL: " << error.what() << '\n';
        return 1;
    }
}

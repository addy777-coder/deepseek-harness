#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <span>
#include <string>
#include <vector>

namespace dsh::vpn {

class LwipStack;
namespace detail {
struct StreamState;
struct StackCore;
}

/** A TCP stream carried exclusively by the owning stack's in-memory netif. */
class Stream final {
public:
    struct Callbacks {
        std::function<void()> connected;
        // Bytes are borrowed for this call. Copy them before returning and return
        // receive-window credit with consume_received() after the local write.
        std::function<void(std::span<const std::uint8_t>)> received;
        std::function<void()> writable;
        // Empty error means peer EOF. Already delivered bytes may still need to
        // drain; consume_received() remains valid until those writes complete.
        std::function<void(std::string)> closed;
    };

    ~Stream();
    Stream(const Stream&) = delete;
    Stream& operator=(const Stream&) = delete;

    /** Copies bytes into lwIP's bounded send queue; retry the remainder on writable. */
    std::size_t write(std::span<const std::uint8_t> bytes);
    /** Returns credit only for received bytes successfully written to the consumer. */
    void consume_received(std::size_t count);
    /** Cancels the stream synchronously and suppresses all subsequent callbacks. */
    void close() noexcept;

private:
    friend class LwipStack;
    explicit Stream(std::shared_ptr<detail::StreamState> state);
    std::shared_ptr<detail::StreamState> state_;
};

/**
 * Single-threaded IPv4 lwIP adapter. Every API and callback runs on its creating
 * thread. One instance may be constructed per process because lwIP's DNS cache,
 * protocol pools, and timers are process-global. Restart the helper to reconnect.
 */
class LwipStack final {
public:
    struct Options {
        std::size_t max_streams = 16;
        std::chrono::milliseconds connect_timeout{30000};
    };

    // Packets are borrowed for the callback; copy before an asynchronous send.
    // Never invoke input() or poll_timers() recursively from this callback.
    using Output = std::function<void(std::span<const std::uint8_t>)>;

    explicit LwipStack(Output output);
    LwipStack(Output output, Options options);
    ~LwipStack();
    LwipStack(const LwipStack&) = delete;
    LwipStack& operator=(const LwipStack&) = delete;

    /** Configures one immutable IPv4 tunnel, with DNS servers supplied by that VPN. */
    void configure(const std::string& address, const std::string& netmask,
                   const std::string& gateway, const std::vector<std::string>& dns,
                   std::uint16_t mtu = 1500);
    /** Starts on the next poll_timers(), so callbacks cannot run before return. */
    std::shared_ptr<Stream> connect(std::string host, std::uint16_t port,
                                    Stream::Callbacks callbacks);
    /** Delivers one raw IPv4 packet from the authenticated VPN data channel. */
    void input(std::span<const std::uint8_t> packet);
    /** Call periodically from the same event loop, including while TCP is idle. */
    void poll_timers();
    /** Disables the netif and cancels all streams without delivering callbacks. */
    void shutdown() noexcept;

private:
    std::unique_ptr<detail::StackCore> impl_;
};

} // namespace dsh::vpn

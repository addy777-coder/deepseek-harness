#ifndef DSH_VPN_LWIP_ARCH_CC_H
#define DSH_VPN_LWIP_ARCH_CC_H

#include <stdint.h>
#include <stdlib.h>

#ifndef BYTE_ORDER
#define BYTE_ORDER LITTLE_ENDIAN
#endif

#if defined(_MSC_VER)
#define PACK_STRUCT_BEGIN __pragma(pack(push, 1))
#define PACK_STRUCT_END __pragma(pack(pop))
#define PACK_STRUCT_STRUCT
#endif

#ifdef __cplusplus
extern "C" {
#endif
uint32_t dsh_lwip_rand(void);
void dsh_lwip_assert(void);
#ifdef __cplusplus
}
#endif

#define LWIP_RAND() dsh_lwip_rand()
/* Never print packet bytes or DNS names through upstream diagnostics. */
#define LWIP_PLATFORM_DIAG(x) do {} while (0)
#define LWIP_PLATFORM_ASSERT(message) dsh_lwip_assert()

#endif

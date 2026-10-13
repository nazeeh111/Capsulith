/* SPDX-License-Identifier: MIT
 * Packaging adapter only. The codec body is unchanged upstream qoi.h.
 */
#define QOI_IMPLEMENTATION
#define QOI_NO_STDIO
#include "qoi.h"

unsigned capsulith_qoi_free(void *allocation) {
    free(allocation);
    return 0;
}

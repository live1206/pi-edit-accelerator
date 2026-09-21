#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <malloc.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

/*
 * Linux/glibc-only cumulative allocation profiler used by the validation
 * harness. It counts requested bytes across V8, Node, and the Rust addon.
 * Marker writes delimit one operation without requiring another Node addon.
 */

extern void *__libc_malloc(size_t size);
extern void *__libc_calloc(size_t count, size_t size);
extern void *__libc_realloc(void *pointer, size_t size);
extern void __libc_free(void *pointer);
extern void *__libc_memalign(size_t alignment, size_t size);

static _Atomic unsigned long long allocated_bytes = 0;
static const char reset_marker[] = "__PI_EDIT_ALLOC_RESET__\n";
static const char sample_marker[] = "__PI_EDIT_ALLOC_SAMPLE__\n";

static void add_bytes(size_t size) {
  atomic_fetch_add_explicit(&allocated_bytes, (unsigned long long)size, memory_order_relaxed);
}

void *malloc(size_t size) {
  add_bytes(size);
  return __libc_malloc(size);
}

void *calloc(size_t count, size_t size) {
  if (count != 0 && size > SIZE_MAX / count) return NULL;
  add_bytes(count * size);
  return __libc_calloc(count, size);
}

void *realloc(void *pointer, size_t size) {
  add_bytes(size);
  return __libc_realloc(pointer, size);
}

void free(void *pointer) {
  __libc_free(pointer);
}

void *aligned_alloc(size_t alignment, size_t size) {
  add_bytes(size);
  return __libc_memalign(alignment, size);
}

int posix_memalign(void **result, size_t alignment, size_t size) {
  if (alignment < sizeof(void *) || (alignment & (alignment - 1)) != 0) {
    return EINVAL;
  }
  void *pointer = __libc_memalign(alignment, size);
  if (pointer == NULL) return ENOMEM;
  add_bytes(size);
  *result = pointer;
  return 0;
}

static void record_sample(unsigned long long bytes) {
  const char *path = getenv("PI_EDIT_ALLOC_PROFILE_PATH");
  if (path == NULL || path[0] == '\0') return;
  int fd = open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
  if (fd < 0) return;
  char line[64];
  int length = snprintf(line, sizeof(line), "%llu\n", bytes);
  if (length > 0) (void)syscall(SYS_write, fd, line, (size_t)length);
  (void)close(fd);
}

ssize_t write(int fd, const void *buffer, size_t count) {
  if (count == sizeof(reset_marker) - 1 && memcmp(buffer, reset_marker, count) == 0) {
    atomic_store_explicit(&allocated_bytes, 0, memory_order_relaxed);
    return (ssize_t)count;
  }
  if (count == sizeof(sample_marker) - 1 && memcmp(buffer, sample_marker, count) == 0) {
    record_sample(atomic_load_explicit(&allocated_bytes, memory_order_relaxed));
    return (ssize_t)count;
  }
  return (ssize_t)syscall(SYS_write, fd, buffer, count);
}

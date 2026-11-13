// a job's memory: pages mapped for it, carved in order, and all unmapped
// once it ends, whatever it did not give back: its reads, rasters and
// decodes never outlive it, nor wait in an allocator for another job. a
// piece over BIG has a mapping of its own, which unmem() gives back: kept
// for the job's next piece of its size while it and those kept come to
// SPARE or less (a decode's planes), else unmapped at once. every piece
// comes zeroed. what outlives the job (its results, the shared caches) is
// malloc's
#include "burnoff.h"
#include <sys/mman.h>

#define BIG (256 << 10)
#define SPARE (16 << 20)
typedef struct map { struct map *next; size_t n, used, last; } map;
typedef struct { size_t n, own; } hdr;
typedef struct { map *small, *big, *spare; size_t kept; } region;
static __thread region zone;   // the job's on this thread

// a mapping of s bytes, zeroed, or for a piece of its own a spare one of
// up to 2s, zeroed as far as the piece reaches
static map *mapping(size_t s, int own) {
  map **f = &zone.spare, *m = NULL;
  while (own && (m = *f) && (m->n < s || m->n > 2 * s)) f = &m->next;
  if (m) {
    size_t n = m->n;
    *f = m->next, zone.kept -= n, memset(m, 0, s), m->n = n;
  } else if ((m = mmap(NULL, s, PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANON, -1, 0)) == MAP_FAILED)
    return NULL;
  else m->n = s;
  return m;
}

void *mem(size_t n) {
  size_t k = sizeof(hdr) + (n + 15) / 16 * 16;
  int own = k > BIG;
  map **l = own ? &zone.big : &zone.small, *m = *l;
  if (own || !m || m->used + k > m->n) {
    if (!(m = mapping(own ? sizeof *m + k : 4 * BIG, own))) return NULL;
    m->next = *l, m->used = sizeof *m, *l = m;
  }
  hdr *h = (hdr *)((char *)m + (m->last = m->used));
  m->used += k, *h = (hdr){n, own};
  return h + 1;
}

void unmem(void *p) {
  map *m = p && ((hdr *)p)[-1].own ? (map *)((hdr *)p - 1) - 1 : NULL;
  for (map **l = &zone.big; m && *l; l = &(*l)->next)
    if (*l == m) {
      *l = m->next;
      if (zone.kept + m->n > SPARE) munmap(m, m->n);
      else m->next = zone.spare, zone.spare = m, zone.kept += m->n;
      return;
    }
}

// p grown to n bytes: in place where it is the last piece of its mapping
// and they fit, else copied
void *remem(void *p, size_t n) {
  hdr *h = p ? (hdr *)p - 1 : NULL;
  map *m = zone.small;
  size_t k = sizeof(hdr) + (n + 15) / 16 * 16;
  if (h && !h->own && m && (char *)h == (char *)m + m->last && n >= h->n &&
      m->last + k <= m->n)
    return m->used = m->last + k, h->n = n, p;
  void *q = mem(n);
  if (q && h) memcpy(q, p, MIN(h->n, n)), unmem(p);
  return q;
}

static void unmap(map *m) {
  for (map *n; m; m = n) n = m->next, munmap(m, m->n);
}

// the job on this thread is done
void let(void) {
  unmap(zone.small), unmap(zone.big), unmap(zone.spare), zone = (region){0};
}


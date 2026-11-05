// shared byte-range reads, workers and DuckDB helpers. detectors own their
// state.
#ifndef BURNOFF_H
#define BURNOFF_H
#define _GNU_SOURCE
#include <math.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <time.h>
#define DUCKDB_EXTENSION_NAME burnoff
#define DUCKDB_EXTENSION_API_VERSION_MAJOR 1
#define DUCKDB_EXTENSION_API_VERSION_MINOR 2
#define DUCKDB_EXTENSION_API_VERSION_PATCH 0
#include "duckdb_extension.h"
DUCKDB_EXTENSION_EXTERN

#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define MAX(a, b) ((a) > (b) ? (a) : (b))

// bytes read, the file's size when the answer gave it, and the seconds a
// 429 asked us to wait
typedef struct {
  unsigned char *p;
  size_t n, cap;
  long long size;
  int wait;
} buf;

// a read of [lo, hi) of url (hi -1: to the end, -2: the file's size alone)
// that a stage lacks. the host makes it and check()s each answer; the
// stage, run again, finds it with got(). [wl, wh) is the range wanted, of
// which reads in hand held the rest: the read is made whole by fill().
// sc: scanned for SOT markers
typedef struct {
  char *url;
  long long lo, hi, wl, wh;
  buf b;
  const char *e;
  int ok, tries, wait, sc;
} rd;

// Reads survive successive boxes on the same worker (S3's granule sharing).
typedef struct {
  rd *rq;
  int nr, rcap;
  long long gap;
  struct connection *connection;
} job;

// A queued row, optionally followed by rows sharing the same source.
typedef struct row {
  struct row *next, *same;
  char *url;
  void *data;
  void (*work)(struct row *, job *);
  int follow;
  const char *e;
  int *left;
  pthread_mutex_t *m;
  pthread_cond_t *c;
} row;

extern const char PAST[], LACK[], FIN[];
void drop(buf *b);
void append(buf *b, const void *p, size_t n);
rd *add(job *j, const char *url, long long lo, long long hi);
rd *got(job *j, const char *url, long long lo, long long hi);
const char *want(job *j, const char *url, long long lo, long long hi);
void forget(job *j, const char *url);
void read_round(job *j);
void run(row *rs, idx_t n);
void spread(void (*f)(void *, size_t), void *a, size_t n);
int merge(long long *q, int n, long long gap, int limit);
char *swap(const char *url, const char *from, const char *to);
int find(int *p, int i);
const char *params(const char *s, double *t, const char **names, int n);
int valid(duckdb_vector v, idx_t i);
char *str(duckdb_vector v, idx_t i);
duckdb_logical_type type(duckdb_type t);
duckdb_state s2_register(duckdb_connection con);
duckdb_state s3_register(duckdb_connection con);
#endif

// gpu: jpeg 2000 tier-1 and inverse 5/3, and b12's screen, on the gpu with
// web/j2k.wgsl, the kernels the browser runs (web/gpu.js), over
// wgpu-native's webgpu.h: metal on macos, vulkan on linux. one device a
// process, its pipelines built once; any thread calls at any time, each
// call with its own buffers and command buffer, so one row's tier-2,
// uploads and waits overlap others' kernels (wgpu-native's device and
// queue take calls from many threads: checked with 2 to 8 rows at once and
// two such processes). each gives NULL, or why not, for the cpu to do the
// work instead; gpu_off once the gpu is off for the process (no adapter, a
// gpu error, a stall)
//   gpu_decode(rec, n, seg, ns, tile, nt, levels, prec, out, h)
// rec: n code-blocks, 5 uint32 each (j2k.wgsl has the layout), over segment
// bytes seg[0, ns); tile: nt tiles, 8 int32 each, a tile's rect and the
// window wanted of it, in image coordinates. out gets the windows' samples,
// each row-major from an even offset: tile i's at 2 Σj<i ⌈area j / 2⌉. with
// out NULL they stay on the gpu, not yet run, and *h is a handle to them.
//   gpu_cells(h, cq, n, out)
// j2k.wgsl's cells, ring and squares over decode h, which it ends, reading
// cq (n uint32, burnoff.c's table()). *out, malloc'd, gets 8 uint32 a
// cell, the candidates' number k, 2 a 640 m square, then 2 a candidate
// (box index, dn) in no order and its ring, k
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <webgpu/wgpu.h>
#include "j2k.wgsl.h"

typedef WGPUBuffer B;
typedef WGPUBindGroupEntry G;
static WGPUDevice dev;
static WGPUComputePipeline T1[2], DWT, FIN, CELLS, RING, SQ, MARK;
static WGPUBuffer cy;
const char *gpu_off;
static char msg[4096];
static pthread_once_t once = PTHREAD_ONCE_INIT;
// a decode kept for gpu_cells: tiles, samples and its pass, not yet ended,
// so that the cells join it and one canary covers both
typedef struct { B bt, bo; WGPUCommandEncoder c; WGPUComputePassEncoder k; }
  kept;
#define S WGPUBufferUsage_Storage
#define CS WGPUBufferUsage_CopySrc
#define SV(s) ((WGPUStringView){s, WGPU_STRLEN})
#define E(b, x) {.binding = b, .buffer = x, .size = WGPU_WHOLE_SIZE}
#define CB(f, u) {.mode = WGPUCallbackMode_AllowProcessEvents, .callback = f, \
                  .userdata1 = u}
#define MAX(a, b) ((a) > (b) ? (a) : (b))

static void ad(WGPURequestAdapterStatus s, WGPUAdapter a, WGPUStringView m,
               void *u, void *v) {
  *(WGPUAdapter *)u = s == WGPURequestAdapterStatus_Success ? a : NULL;
}
static void de(WGPURequestDeviceStatus s, WGPUDevice d, WGPUStringView m,
               void *u, void *v) {
  *(WGPUDevice *)u = s == WGPURequestDeviceStatus_Success ? d : NULL;
}
// from whichever thread polls
static void mp(WGPUMapAsyncStatus s, WGPUStringView m, void *u, void *v) {
  __atomic_store_n((int *)u, s, __ATOMIC_RELEASE);
}
// wgpu-native panics on an error nobody catches: keep the first, or the
// device's loss
static void oops(WGPUDevice const *d, int t, WGPUStringView m, void *u,
                 void *v) {
  if (!gpu_off) snprintf(msg, sizeof msg, "gpu: %.*s", (int)m.length, m.data),
            gpu_off = msg;
}

// entry e of the module for blocks up to 32 (r) or 8 square: the other's
// //N{ ... //} lines cut out
static WGPUComputePipeline pipe(int r, char *e) {
  static WGPUShaderModule m[2];
  if (!m[r]) {
    const char *a = strstr(WGSL, r ? "//8{" : "//32{"), *b = strstr(a, "//}");
    char *s = malloc(sizeof WGSL);
    snprintf(s, sizeof WGSL, "%.*s%s", (int)(a - WGSL), WGSL, b + 3);
    WGPUShaderSourceWGSL w = {{NULL, WGPUSType_ShaderSourceWGSL}, SV(s)};
    m[r] = wgpuDeviceCreateShaderModule(dev,
      &(WGPUShaderModuleDescriptor){.nextInChain = &w.chain});
    free(s);
  }
  return wgpuDeviceCreateComputePipeline(dev, &(WGPUComputePipelineDescriptor){
    .compute = {.module = m[r], .entryPoint = SV(e)}});
}

// fresh buffers read as zeros
static B buf(WGPUBufferUsage u, size_t s, const void *d) {
  B b = wgpuDeviceCreateBuffer(dev, &(WGPUBufferDescriptor){.usage = u,
    .size = s < 16 ? 16 : (s + 3) & ~3, .mappedAtCreation = !!d});
  if (d) memcpy(wgpuBufferGetMappedRange(b, 0, WGPU_WHOLE_MAP_SIZE), d, s),
         wgpuBufferUnmap(b);
  return b;
}
static void drop(int n, B *b) {
  for (int i = 0; i < n; i++)
    if (b[i]) wgpuBufferRelease(b[i]);
}

// waits on wgpuInstanceProcessEvents: wgpu-native answers at once
static void init(void) {
  WGPUInstance in = wgpuCreateInstance(NULL);
  WGPUAdapter a = NULL;
  WGPULimits l = WGPU_LIMITS_INIT;
  wgpuInstanceRequestAdapter(in, NULL,
                             (WGPURequestAdapterCallbackInfo)CB(ad, &a));
  wgpuInstanceProcessEvents(in);
  if (!a) { gpu_off = "no gpu adapter"; return; }
  wgpuAdapterGetLimits(a, &l);
  wgpuAdapterRequestDevice(a, &(WGPUDeviceDescriptor){.requiredLimits = &l,
    .uncapturedErrorCallbackInfo = {.callback = (void *)oops},
    .deviceLostCallbackInfo = {.mode = WGPUCallbackMode_AllowSpontaneous,
                               .callback = (void *)oops}},
    (WGPURequestDeviceCallbackInfo)CB(de, &dev));
  wgpuInstanceProcessEvents(in);
  if (!dev) { gpu_off = "no gpu device"; return; }
  T1[0] = pipe(0, "t1"), T1[1] = pipe(1, "t1");
  DWT = pipe(0, "dwt"), FIN = pipe(0, "fin"), CELLS = pipe(0, "cells");
  RING = pipe(0, "ring"), SQ = pipe(0, "squares"), MARK = pipe(0, "mark");
  cy = buf(WGPUBufferUsage_CopySrc, 4, (uint32_t[]){0xb0ff});
}

// a dispatch of pipeline p with bindings e: x workgroups by y, those of x
// past the limit of 65535 folded into y. a stage's dispatches share one
// pass: on metal, wgpu-native let a pass begin before the one ahead of it
// had finished (a dwt step reading tiles the last had not yet written,
// with other processes on the gpu), but orders dispatches within a pass
static void pass(WGPUComputePassEncoder k, WGPUComputePipeline p, int ne,
                 G *e, int x, int y) {
  WGPUBindGroupLayout l = wgpuComputePipelineGetBindGroupLayout(p, 0);
  WGPUBindGroup b = wgpuDeviceCreateBindGroup(dev, &(WGPUBindGroupDescriptor){
    .layout = l, .entryCount = ne, .entries = e});
  wgpuComputePassEncoderSetPipeline(k, p);
  wgpuComputePassEncoderSetBindGroup(k, 0, b, 0, NULL);
  wgpuComputePassEncoderDispatchWorkgroups(k, x < 65535 ? x : 65535,
                                           y * ((x + 65534) / 65535), 1);
  wgpuBindGroupRelease(b), wgpuBindGroupLayoutRelease(l);
}

// the pass k ended with a dispatch that writes a canary, in the buffer
// given. with other processes on the gpu, metal at times skips a pass of a
// long stage (a whole tile of 32 x 32 blocks, 0.6 s, with two more at
// once) and wgpu-native does not say so, nor, at times, return
static B mark(WGPUComputePassEncoder k) {
  B y = buf(S | CS, 4, NULL);
  pass(k, MARK, 1, (G[]){E(12, y)}, 1, 1);
  wgpuComputePassEncoderEnd(k), wgpuComputePassEncoderRelease(k);
  return y;
}

// submits c (or a new encoder), then waits for and copies b's s bytes
// from o (multiples of 4) into d, and checks that y's canary (or the
// one copied from cy) came too. a wait ends after 30 s
static const char *fetch(WGPUCommandEncoder c, B b, size_t o, size_t s,
                         void *d, B y) {
  WGPUQueue q = wgpuDeviceGetQueue(dev);
  B r = buf(WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst, s + 4, NULL);
  int ok = 0, t = 0;
  const char *e = "gpu work dropped";
  if (!c) c = wgpuDeviceCreateCommandEncoder(dev, NULL);
  wgpuCommandEncoderCopyBufferToBuffer(c, b, o, r, 0, s);
  wgpuCommandEncoderCopyBufferToBuffer(c, y ? y : cy, 0, r, s, 4);
  WGPUCommandBuffer k = wgpuCommandEncoderFinish(c, NULL);
  wgpuQueueSubmit(q, 1, &k);
  // wgpu-native 29 refuses WGPU_WHOLE_MAP_SIZE here
  wgpuBufferMapAsync(r, WGPUMapMode_Read, 0, wgpuBufferGetSize(r),
                     (WGPUBufferMapCallbackInfo)CB(mp, &ok));
  for (; !__atomic_load_n(&ok, __ATOMIC_ACQUIRE) && !gpu_off; t++)
    if (wgpuDevicePoll(dev, 0, NULL), t == 300000) gpu_off = "gpu stalled";
    else nanosleep(&(struct timespec){0, 100000}, NULL);
  const uint32_t *m = ok == WGPUMapAsyncStatus_Success ?
    wgpuBufferGetConstMappedRange(r, 0, wgpuBufferGetSize(r)) : NULL;
  if (m && m[s / 4] == 0xb0ff) memcpy(d, m, s), e = NULL;
  drop(2, (B[]){r, y}), wgpuCommandBufferRelease(k);
  wgpuCommandEncoderRelease(c);
  wgpuQueueRelease(q);
  return gpu_off ? gpu_off : e;
}

const char *gpu_decode(const uint32_t *rec, size_t n, const uint8_t *seg,
                       size_t ns, const int32_t *tile, int nt, int levels,
                       int prec, uint16_t *out, void **h) {
  pthread_once(&once, init);
  if (gpu_off) return gpu_off;
  uint32_t *tl = calloc(12 * nt, 4), (*st)[64] = calloc(2 * levels + 1, 256);
  size_t px = 0, ow = 0, wm = 0, am = 0, R = 0;
  const char *e = NULL;
  int i;
  // the planes, each tile's from px; the windows, each from 2 ow
  for (i = 0; i < nt; i++) {
    const int32_t *t = tile + 8 * i;
    size_t m = ((size_t)(t[6] - t[4]) * (t[7] - t[5]) + 1) / 2;
    size_t a = (size_t)(t[2] - t[0]) * (t[3] - t[1]);
    memcpy(tl + 12 * i, t, 32), tl[12 * i + 8] = px, tl[12 * i + 9] = ow;
    px += a, ow += m, wm = MAX(m, wm), am = MAX(a, am);
  }
  // blocks wider or taller than 8 take the module for 32
  for (size_t j = 0; j < n; j++) R |= (rec[5 * j + 3] & 0xffff) + 0x707;
  // uniforms, a 256-byte slot a pass: tier-1, a lifting step for each
  // direction of each level but the last, and the last into the windows
  for (i = 0; i <= 2 * levels; i++)
    st[i][0] = i ? (i - 1) & (i < 2 * levels) : n, st[i][1] = levels,
    st[i][2] = (i + 1) / 2, st[i][3] = prec;
  B u = buf(WGPUBufferUsage_Uniform, 256 * (2 * levels + 1), st);
  B bt = buf(S, 48 * nt, tl), br = buf(S, 20 * n, rec), bs = buf(S, ns, seg);
  B pl = buf(S, 4 * px, NULL), tmp = buf(S, 4 * px, NULL);
  B bo = buf(S | CS, 4 * ow, NULL);
  WGPUCommandEncoder c = wgpuDeviceCreateCommandEncoder(dev, NULL);
  WGPUComputePassEncoder k = wgpuCommandEncoderBeginComputePass(c, NULL);
#define U(i) {.binding = 0, .buffer = u, .offset = 256 * (i), .size = 16}
  pass(k, T1[!!(R & 0xf0f0)], 5, (G[]){U(0), E(1, bt), E(2, br), E(3, bs),
       E(4, pl)}, (n + 63) / 64, 1);
  for (i = 1; i < 2 * levels; i++)
    pass(k, DWT, 4, (G[]){U(i), E(1, bt), E(5, i & 1 ? pl : tmp),
         E(4, i & 1 ? tmp : pl)}, (am + 255) / 256, nt);
  pass(k, FIN, 4, (G[]){U(i), E(1, bt), E(5, tmp), E(6, bo)},
       (wm + 255) / 256, nt);
  if (out) e = fetch(c, bo, 0, 4 * ow, out, mark(k)), drop(2, (B[]){bt, bo});
  else *h = memcpy(malloc(sizeof(kept)), &(kept){bt, bo, c, k}, sizeof(kept));
  drop(5, (B[]){u, br, bs, pl, tmp}), free(st), free(tl);
  return e;
}

const char *gpu_cells(void *h, const uint32_t *cq, size_t n,
                      uint32_t **out) {
  size_t nc = cq[9] * ((cq[3] - 1) / 320 - cq[8] + 1), q = 0, cap = cq[16];
  size_t nx = (cq[2] - 1) / 32 - cq[0] / 32 + 1;
  size_t ny = (cq[3] - 1) / 32 - cq[1] / 32 + 1, m = 8 * nc + 1 + 2 * nx * ny;
  kept d = *(kept *)h;
  B bt = d.bt, bo = d.bo;
  WGPUCommandEncoder c = d.c;
  WGPUComputePassEncoder k = d.k;
  free(h);
  B bq = buf(S, 4 * n, cq), bc = buf(S | CS, 32 * nc, NULL);
  B bk = buf(S | CS, 8 * cap + 4, NULL), bg = buf(S | CS, 4 * cap, NULL);
  B bs = buf(S | CS, 8 * nx * ny, NULL);
  B r = buf(CS | WGPUBufferUsage_CopyDst, 4 * m, NULL);
  // after the decode, the cells, then each candidate's ring and the
  // squares, read back with the candidates' number, then the candidates
  pass(k, CELLS, 5, (G[]){E(1, bt), E(6, bo), E(7, bq), E(8, bc), E(9, bk)},
       nc, 1);
  pass(k, RING, 6, (G[]){E(1, bt), E(6, bo), E(7, bq), E(8, bc), E(9, bk),
       E(10, bg)}, 1024, 1);
  pass(k, SQ, 5, (G[]){E(1, bt), E(6, bo), E(7, bq), E(8, bc), E(11, bs)},
       nx, ny);
  B y = mark(k);
  wgpuCommandEncoderCopyBufferToBuffer(c, bc, 0, r, 0, 32 * nc);
  wgpuCommandEncoderCopyBufferToBuffer(c, bk, 0, r, 32 * nc, 4);
  wgpuCommandEncoderCopyBufferToBuffer(c, bs, 0, r, 32 * nc + 4, 8 * nx * ny);
  const char *e = fetch(c, r, 0, 4 * m, *out = malloc(4 * m), y);
  if (!e && (q = (*out)[8 * nc]) > cap) e = "too many candidates";
  if (!e && q)
    *out = realloc(*out, 4 * (m + 3 * q)),
    e = fetch(NULL, bk, 4, 8 * q, *out + m, NULL),
    e = e ? e : fetch(NULL, bg, 0, 4 * q, *out + m + 2 * q, NULL);
  drop(8, (B[]){bt, bo, bq, bc, bk, bg, bs, r});
  if (e) free(*out), *out = NULL;
  return e;
}

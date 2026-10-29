// gpu: jpeg 2000 tier-1 and inverse 5/3, and run()'s background cells, on
// the gpu with web/j2k.wgsl, the kernels the browser runs (web/gpu.js), over
// wgpu-native's webgpu.h: metal on macos, vulkan on linux. one device a
// process, its pipelines built on first use; calls take turns, as the gpu
// would run them in turn anyway. each gives NULL, or why not (no adapter, or
// a gpu error, after which the gpu is off for the process) for the cpu to
// do the work instead.
//   gpu_decode(rec, n, seg, ns, tile, nt, levels, prec, out)
// rec: n code-blocks, 5 uint32 each (j2k.wgsl has the layout), over segment
// bytes seg[0, ns); tile: nt tiles, 8 int32 each, a tile's rect and the
// window wanted of it, in image coordinates. out gets the windows' samples,
// each row-major from an even offset: tile i's at 2 Σj<i ⌈area j / 2⌉. with
// out NULL they stay on the gpu, the calling thread's, for gpu_cells.
//   gpu_cells(box, mask, nm, mw, t, cells, cand, nk, hot)
// run()'s cells and candidates over box (x0 y0 x1 y1, in pixels of this
// thread's last decode, kept): mask the 60 m cloudy flags (nm bytes, mw a
// row), t the thresholds in burnoff.c's order. *cells gets 8 uint32 a 320 px
// cell, row by row (j2k.wgsl has them), *cand the *nk candidates' box index
// and dn pairs in raster order, both malloc'd; *hot whether a dn reaches
// peak_b12_min
#include <stdint.h>
#include <stdlib.h>
#ifndef GPU
const char *gpu_decode(const uint32_t *rec, size_t n, const uint8_t *seg,
                       size_t ns, const int32_t *tile, int nt, int levels,
                       int prec, uint16_t *out) {
  return "built without the gpu";
}
const char *gpu_cells(const int *box, const uint8_t *mask, size_t nm, int mw,
                      const double *t, uint32_t **cells, uint32_t **cand,
                      size_t *nk, int *hot) {
  return "built without the gpu";
}
#else
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <webgpu/wgpu.h>
#include "j2k.wgsl.h"

typedef WGPUBuffer B;
typedef WGPUBindGroupEntry G;
static WGPUDevice dev;
static WGPUComputePipeline T1[2], DWT, FIN, CELLS;
static const char *bad;
static char msg[4096];
static pthread_once_t once = PTHREAD_ONCE_INIT;
static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
// the calling thread's last decode, kept for gpu_cells: tiles and samples
static __thread struct { B bt, bo; uint32_t *tl; int nt; } kept;
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
static void mp(WGPUMapAsyncStatus s, WGPUStringView m, void *u, void *v) {
  *(int *)u = s;
}
// wgpu-native panics on an error nobody catches: keep the first
static void oops(WGPUDevice const *d, WGPUErrorType t, WGPUStringView m,
                 void *u, void *v) {
  if (!bad) snprintf(msg, sizeof msg, "gpu: %.*s", (int)m.length, m.data),
            bad = msg;
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

// waits on wgpuInstanceProcessEvents: wgpu-native answers at once
static void init(void) {
  WGPUInstance in = wgpuCreateInstance(NULL);
  WGPUAdapter a = NULL;
  WGPULimits l = WGPU_LIMITS_INIT;
  wgpuInstanceRequestAdapter(in, NULL,
                             (WGPURequestAdapterCallbackInfo)CB(ad, &a));
  wgpuInstanceProcessEvents(in);
  if (!a) { bad = "no gpu adapter"; return; }
  wgpuAdapterGetLimits(a, &l);
  wgpuAdapterRequestDevice(a, &(WGPUDeviceDescriptor){.requiredLimits = &l,
    .uncapturedErrorCallbackInfo = {.callback = oops}},
    (WGPURequestDeviceCallbackInfo)CB(de, &dev));
  wgpuInstanceProcessEvents(in);
  if (!dev) { bad = "no gpu device"; return; }
  T1[0] = pipe(0, "t1"), T1[1] = pipe(1, "t1");
  DWT = pipe(0, "dwt"), FIN = pipe(0, "fin"), CELLS = pipe(0, "cells");
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
    if (b[i]) wgpuBufferDestroy(b[i]), wgpuBufferRelease(b[i]);
}

// one pass of pipeline p with bindings e: x workgroups by y, those of x
// past the limit of 65535 folded into y
static void pass(WGPUCommandEncoder c, WGPUComputePipeline p, int ne, G *e,
                 int x, int y) {
  WGPUBindGroupLayout l = wgpuComputePipelineGetBindGroupLayout(p, 0);
  WGPUBindGroup b = wgpuDeviceCreateBindGroup(dev, &(WGPUBindGroupDescriptor){
    .layout = l, .entryCount = ne, .entries = e});
  WGPUComputePassEncoder k = wgpuCommandEncoderBeginComputePass(c, NULL);
  wgpuComputePassEncoderSetPipeline(k, p);
  wgpuComputePassEncoderSetBindGroup(k, 0, b, 0, NULL);
  wgpuComputePassEncoderDispatchWorkgroups(k, x < 65535 ? x : 65535,
                                           y * ((x + 65534) / 65535), 1);
  wgpuComputePassEncoderEnd(k), wgpuComputePassEncoderRelease(k);
  wgpuBindGroupRelease(b), wgpuBindGroupLayoutRelease(l);
}

// submits c (or a new encoder), then with b, waits for and copies its s
// bytes from o (multiples of 4) into d
static void fetch(WGPUCommandEncoder c, B b, size_t o, size_t s, void *d) {
  WGPUQueue q = wgpuDeviceGetQueue(dev);
  B r = b ? buf(WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst, s, NULL)
          : NULL;
  int ok = 0;
  if (!c) c = wgpuDeviceCreateCommandEncoder(dev, NULL);
  if (b && s) wgpuCommandEncoderCopyBufferToBuffer(c, b, o, r, 0, s);
  WGPUCommandBuffer k = wgpuCommandEncoderFinish(c, NULL);
  wgpuQueueSubmit(q, 1, &k);
  // wgpu-native 29 refuses WGPU_WHOLE_MAP_SIZE here
  if (b) wgpuBufferMapAsync(r, WGPUMapMode_Read, 0, wgpuBufferGetSize(r),
                            (WGPUBufferMapCallbackInfo)CB(mp, &ok));
  while (b && !ok && !bad) wgpuDevicePoll(dev, 1, NULL);
  if (ok == WGPUMapAsyncStatus_Success)
    memcpy(d, wgpuBufferGetConstMappedRange(r, 0, wgpuBufferGetSize(r)), s);
  else if (b && !bad) bad = "gpu readback failed";
  drop(!!r, &r), wgpuCommandBufferRelease(k), wgpuCommandEncoderRelease(c);
  wgpuQueueRelease(q);
}

const char *gpu_decode(const uint32_t *rec, size_t n, const uint8_t *seg,
                       size_t ns, const int32_t *tile, int nt, int levels,
                       int prec, uint16_t *out) {
  pthread_once(&once, init);
  pthread_mutex_lock(&mu);
  if (bad) return pthread_mutex_unlock(&mu), bad;
  uint32_t *tl = calloc(12 * nt, 4), (*st)[64] = calloc(2 * levels + 1, 256);
  size_t px = 0, ow = 0, wm = 0, am = 0, R = 0;
  // the planes, each tile's from px; the windows, each from 2 ow
  for (int i = 0; i < nt; i++) {
    const int32_t *t = tile + 8 * i;
    size_t m = ((size_t)(t[6] - t[4]) * (t[7] - t[5]) + 1) / 2;
    size_t a = (size_t)(t[2] - t[0]) * (t[3] - t[1]);
    memcpy(tl + 12 * i, t, 32), tl[12 * i + 8] = px, tl[12 * i + 9] = ow;
    px += a, ow += m, wm = MAX(m, wm), am = MAX(a, am);
  }
  // blocks wider or taller than 8 take the module for 32
  for (size_t i = 0; i < n; i++) R |= (rec[5 * i + 3] & 0xffff) + 0x707;
  // uniforms, a 256-byte slot a pass: tier-1, a lifting step for each
  // direction of each level but the last, and the last into the windows
  for (int i = 0; i <= 2 * levels; i++)
    st[i][0] = i ? (i - 1) & (i < 2 * levels) : n, st[i][1] = levels,
    st[i][2] = (i + 1) / 2, st[i][3] = prec;
  B u = buf(WGPUBufferUsage_Uniform, 256 * (2 * levels + 1), st);
  B bt = buf(S, 48 * nt, tl), br = buf(S, 20 * n, rec), bs = buf(S, ns, seg);
  B pl = buf(S, 4 * px, NULL), tmp = buf(S, 4 * px, NULL);
  B bo = buf(S | CS, 4 * ow, NULL);
  WGPUCommandEncoder c = wgpuDeviceCreateCommandEncoder(dev, NULL);
#define U(i) {.binding = 0, .buffer = u, .offset = 256 * (i), .size = 16}
  pass(c, T1[!!(R & 0xf0f0)], 5, (G[]){U(0), E(1, bt), E(2, br), E(3, bs),
       E(4, pl)}, (n + 63) / 64, 1);
  for (int i = 1; i < 2 * levels; i++)
    pass(c, DWT, 4, (G[]){U(i), E(1, bt), E(5, i & 1 ? pl : tmp),
         E(4, i & 1 ? tmp : pl)}, (am + 255) / 256, nt);
  pass(c, FIN, 4, (G[]){U(2 * levels), E(1, bt), E(5, tmp), E(6, bo)},
       (wm + 255) / 256, nt);
  fetch(c, out ? bo : NULL, 0, 4 * ow, out);
  drop(5, (B[]){u, br, bs, pl, tmp}), drop(2, &kept.bt), free(kept.tl);
  kept.bt = bt, kept.bo = bo, kept.tl = tl, kept.nt = nt;
  if (out) drop(2, &kept.bt), free(tl), memset(&kept, 0, sizeof kept);
  free(st);
  pthread_mutex_unlock(&mu);
  return bad;
}

// run()'s comparisons of doubles, made cuts in dn: a dn's value, and the
// least dn from d whose value is over v (or with e, at least v)
static double cal(int d) { return d ? (d - 1000) / 10000. : 0; }
static int least(double v, int e, int d) {
  while (d < 65536 && !(cal(d) > v || (e && cal(d) == v))) d++;
  return d;
}
static int by(const void *a, const void *b) {
  return (*(uint32_t *)a > *(uint32_t *)b) - (*(uint32_t *)a < *(uint32_t *)b);
}

const char *gpu_cells(const int *box, const uint8_t *mask, size_t nm, int mw,
                      const double *t, uint32_t **cells, uint32_t **cand,
                      size_t *nk, int *hot) {
  // thresholds: b12_min, peak_b12_min, contrast_ratio, background_floor,
  // max_cloud_local
  double b = t[0], pk = t[2], cr = t[3], bf = t[4], mc = t[14];
  int X0 = box[0], Y0 = box[1], X1 = box[2], Y1 = box[3];
  uint32_t *tl = kept.tl, k = 0, tw = 0, th = 0, iw = 0, ih = 0;
  int m = 1;
  if (!kept.bt) return "no decode kept on the gpu";
  for (int i = 0; i < 12 * kept.nt; i += 12)
    tw = MAX(tw, tl[i + 2] - tl[i]), th = MAX(th, tl[i + 3] - tl[i + 1]),
    iw = MAX(iw, tl[i + 2]), ih = MAX(ih, tl[i + 3]);
  int nx = (iw + tw - 1) / tw, ns = nx * ((ih + th - 1) / th);
  int gx0 = X0 / 320, gy0 = Y0 / 320, ncx = (X1 - 1) / 320 - gx0 + 1;
  int nc = ncx * ((Y1 - 1) / 320 - gy0 + 1);
  size_t cap = (size_t)(X1 - X0) * (Y1 - Y0);
  // dim under m; a candidate at or over a and over the contrast on its
  // cell's median
  while (m < ceil(1000 + b * 10000) && cal(m) < b) m++;
  if (m > 4064) return "b12_min past the histogram";
  int a = least(b, 0, 1), o = 17 + ns + 102401 + m;
  uint32_t *cq = calloc(o + (nm + 3) / 4, 4);
  cap = cap < 1 << 22 ? cap : 1 << 22;
  memcpy(cq, (uint32_t[]){X0, Y0, X1, Y1, tw, th, nx, gx0, gy0, ncx, mw, m,
         17, 17 + ns, 17 + ns + 102401, o, cap}, 68);
  memset(cq + 17, 0xff, 4 * ns);
  for (int i = 0; i < kept.nt; i++)
    cq[17 + tl[12 * i + 1] / th * nx + tl[12 * i] / tw] = i;
  for (int n = 0; n <= 102400; n++) cq[17 + ns + n] = floor(mc * n);
  for (int i = 0; i < m; i++) {
    double ct = fmax(cal(i), bf) * cr;
    int d = least(ct, 0, MAX(1, (int)floor(ct * 1e4) + 990));
    cq[o - m + i] = MAX(a, d);
  }
  memcpy(cq + o, mask, nm);
  pthread_once(&once, init);
  pthread_mutex_lock(&mu);
  if (bad) return pthread_mutex_unlock(&mu), free(cq), bad;
  B bq = buf(S, 4 * (o + (nm + 3) / 4), cq), bc = buf(S | CS, 32 * nc, NULL);
  B bk = buf(S | CS, 8 * cap + 4, NULL);
  WGPUCommandEncoder c = wgpuDeviceCreateCommandEncoder(dev, NULL);
  pass(c, CELLS, 5, (G[]){E(1, kept.bt), E(6, kept.bo), E(7, bq), E(8, bc),
       E(9, bk)}, nc, 1);
  fetch(c, bc, 0, 32 * nc, *cells = malloc(32 * nc));
  fetch(NULL, bk, 0, 4, &k);
  const char *e = bad ? bad : k > cap ? "too many candidates" : NULL;
  fetch(NULL, e ? NULL : bk, 4, 8 * k, *cand = malloc(8 * k + 8));
  drop(3, (B[]){bq, bc, bk}), free(cq);
  pthread_mutex_unlock(&mu);
  if ((e = e ? e : bad))
    return free(*cells), free(*cand), *cells = *cand = NULL, e;
  // sorted to raster order
  qsort(*cand, *nk = k, 8, by);
  int p5 = least(pk, 1, 1);
  for (*hot = 0; k--;) *hot |= (*cand)[2 * k + 1] >= (uint32_t)p5;
  return NULL;
}
#endif

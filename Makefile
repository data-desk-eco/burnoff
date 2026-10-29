# one c file over libcurl, with its own jpeg 2000 decoder (src/j2k.c). src/
# holds duckdb v2.0.0's c extension headers; the extension targets the stable
# c api v1.2.0, so it loads in any duckdb from 1.2 on
PKGS = libcurl
CFLAGS ?= -O2 -Wall -Wextra -Wno-unused-parameter
CFLAGS += $(shell pkg-config --cflags $(PKGS))
LDLIBS = $(shell pkg-config --libs $(PKGS)) -lpthread -lm
SRC = src/burnoff.c
PLATFORM ?= $(shell uname -sm | awk '{ \
	os = $$1 == "Darwin" ? "osx" : tolower($$1); \
	arch = $$2 ~ /^(x86_64|amd64)$$/ ? "amd64" : "arm64"; \
	print os "_" arch }')
# GPU=1 (the default) links wgpu-native, static, for src/gpu.c: the
# extension decodes on the gpu when it finds one and on the cpu when not.
# only duckdb's entry point is exported, so the linker drops the rest of
# webgpu: 5.3 MB on osx_arm64 where all of it would take 11
GPU ?= 1
WGPU = v29.0.1.1
WURL = https://github.com/gfx-rs/wgpu-native/releases/download/$(WGPU)/wgpu-$\
  $(subst osx,macos,$(subst amd64,x86_64,$(subst arm64,aarch64,$\
  $(subst _,-,$(PLATFORM)))))-release.zip
GL_osx = -framework Metal -framework QuartzCore -framework Foundation -lobjc \
  -Wl,-dead_strip,-x,-exported_symbol,_burnoff_init_c_api
GL_linux = -ldl -Wl,--gc-sections,--exclude-libs,ALL,-s
ifeq ($(GPU),1)
CFLAGS += -DGPU -Iext/wgpu/include
SRC += src/gpu.c
LDLIBS += ext/wgpu/lib/libwgpu_native.a $(GL_$(word 1,$(subst _, ,$(PLATFORM))))
GPUDEP = ext/wgpu
endif
VERSION ?= $(shell git describe --tags --always 2>/dev/null || echo dev)
E = ext/burnoff.duckdb_extension

# the shared library plus duckdb's metadata footer: a wasm-style custom
# section header, eight 32-byte fields (last first) and 256 bytes left for a
# signature
$(E): src/burnoff.c src/j2k.c src/gpu.c ext/burnoff.sql.h ext/j2k.wgsl.h $(GPUDEP)
	$(CC) $(CFLAGS) -Iext -shared -fPIC $(SRC) $(LDLIBS) -o ext/burnoff.so
	{ cat ext/burnoff.so; printf '\000\223\004\020duckdb_signature\200\004'; \
	  for f in "" "" "" C_STRUCT $(VERSION) v1.2.0 $(PLATFORM) 4; do \
	    printf '%s' "$$f"; head -c $$((32 - $${#f})) /dev/zero; done; \
	  head -c 256 /dev/zero; } > $@
	rm ext/burnoff.so

# the macros, run on load: each line a c string
ext/burnoff.sql.h: src/burnoff.sql
	@mkdir -p ext
	sed 's/\\/\\\\/g; s/"/\\"/g; s/.*/"&\\n"/' $< > $@

# the kernels, the browser's too (web/gpu.js): one c string
ext/j2k.wgsl.h: web/j2k.wgsl
	@mkdir -p ext
	{ echo 'static const char WGSL[] ='; \
	  sed 's/\\/\\\\/g; s/"/\\"/g; s/.*/"&\\n"/' $<; echo ';'; } > $@

# wgpu-native's release for this platform: headers and a static library
ext/wgpu:
	@mkdir -p ext
	curl -fsSL -o ext/wgpu.zip $(WURL)
	unzip -q ext/wgpu.zip 'include/*' 'lib/*.a' -d $@ && rm ext/wgpu.zip

# loads, defines its macros and gives a failed row its error, offline
test: $(E)
	duckdb -unsigned -c "install spatial; load spatial; load '$(CURDIR)/$(E)'; select \
	  coalesce(s2_detect('file:///none', 0, 0, 1, 1).error, error('no error'))"

# into ~/.duckdb/extensions, so `load burnoff` works from any directory
install: $(E)
	duckdb -unsigned -c "force install '$(CURDIR)/$(E)'"

# the detector for the browser, with emscripten: web/burnoff.{js,wasm}, the
# job's calls exported for worker.js
EXPORTS = _detect,_next,_reads,_answer,_result,_records,_took,_tiles,_free,$\
  _malloc
wasm: web/burnoff.js
web/burnoff.js: web/burnoff.c src/burnoff.c src/j2k.c
	emcc -O3 -msimd128 -Wno-constant-conversion $< -o $@ -sMODULARIZE \
	  -sEXPORT_ES6 -sENVIRONMENT=worker -sALLOW_MEMORY_GROWTH \
	  -sMAXIMUM_MEMORY=4GB \
	  -sEXPORTED_FUNCTIONS=$(EXPORTS) \
	  -sEXPORTED_RUNTIME_METHODS=ccall,UTF8ToString,HEAPU8

clean:
	rm -rf ext

.PHONY: test install clean wasm

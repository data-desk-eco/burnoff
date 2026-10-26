# one c file over libcurl and libopenjp2 (>= 2.5 for windowed decode). src/
# holds duckdb v2.0.0's c extension headers; the extension targets the stable
# c api v1.2.0, so it loads in any duckdb from 1.2 on
PKGS = libcurl libopenjp2
CFLAGS ?= -O2 -Wall -Wextra -Wno-unused-parameter
CFLAGS += $(shell pkg-config --cflags $(PKGS))
LDLIBS = $(shell pkg-config --libs $(PKGS)) -lpthread -lm
PLATFORM ?= $(shell uname -sm | awk '{ \
	os = $$1 == "Darwin" ? "osx" : tolower($$1); \
	arch = $$2 ~ /^(x86_64|amd64)$$/ ? "amd64" : "arm64"; \
	print os "_" arch }')
VERSION ?= $(shell git describe --tags --always 2>/dev/null || echo dev)
E = ext/burnoff.duckdb_extension

# the shared library plus duckdb's metadata footer: a wasm-style custom
# section header, eight 32-byte fields (last first) and 256 bytes left for a
# signature
$(E): src/burnoff.c ext/burnoff.sql.h
	$(CC) $(CFLAGS) -Iext -shared -fPIC $< $(LDLIBS) -o ext/burnoff.so
	{ cat ext/burnoff.so; printf '\000\223\004\020duckdb_signature\200\004'; \
	  for f in "" "" "" C_STRUCT $(VERSION) v1.2.0 $(PLATFORM) 4; do \
	    printf '%s' "$$f"; head -c $$((32 - $${#f})) /dev/zero; done; \
	  head -c 256 /dev/zero; } > $@
	rm ext/burnoff.so

# the macros, run on load: each line a c string
ext/burnoff.sql.h: src/burnoff.sql
	@mkdir -p ext
	sed 's/\\/\\\\/g; s/"/\\"/g; s/.*/"&\\n"/' $< > $@

# loads, defines its macros and gives a failed row its error, offline
test: $(E)
	duckdb -unsigned -c "install spatial; load spatial; load '$(CURDIR)/$(E)'; select \
	  coalesce(s2_detect('file:///none', 0, 0, 1, 1).error, error('no error'))"

# into ~/.duckdb/extensions, so `load burnoff` works from any directory
install: $(E)
	duckdb -unsigned -c "force install '$(CURDIR)/$(E)'"

# the detector for the browser, with emscripten: web/burnoff.{js,wasm} over
# openjpeg built for wasm in ext/ojp
OJP = ext/ojp/openjpeg-2.5.4
wasm: web/burnoff.js
web/burnoff.js: web/burnoff.c web/shim/curl/curl.h src/burnoff.c \
                ext/burnoff.sql.h $(OJP)/b/bin/libopenjp2.a
	emcc -O3 -msimd128 -Wno-constant-conversion -Iweb/shim -Iext \
	  -I$(OJP)/src/lib/openjp2 -I$(OJP)/b/src/lib/openjp2 $< \
	  $(OJP)/b/bin/libopenjp2.a -o $@ -sMODULARIZE -sEXPORT_ES6 \
	  -sENVIRONMENT=worker -sALLOW_MEMORY_GROWTH -sMAXIMUM_MEMORY=4GB \
	  -sEXPORTED_FUNCTIONS=_detect,_tiles,_free,_malloc \
	  -sEXPORTED_RUNTIME_METHODS=ccall,UTF8ToString
$(OJP)/b/bin/libopenjp2.a:
	mkdir -p ext/ojp && curl -sL https://github.com/uclouvain/openjpeg/archive/refs/tags/v2.5.4.tar.gz | tar xz -C ext/ojp
	cd $(OJP) && emcmake cmake -B b -DBUILD_SHARED_LIBS=OFF \
	  -DBUILD_CODEC=OFF -DCMAKE_BUILD_TYPE=Release \
	  -DCMAKE_C_FLAGS="-O3 -msimd128 -msse -msse2" && cmake --build b -j8

clean:
	rm -rf ext

.PHONY: test install clean wasm

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

clean:
	rm -rf ext

.PHONY: test install clean

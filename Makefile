# burnoff.duckdb_extension: one c file over libcurl and libopenjp2 (>= 2.5 for
# windowed decode). include/ holds duckdb v2.0.0's C extension headers; the
# extension targets the stable C API v1.2.0, so it loads in any duckdb from
# 1.2 on.
PKGS = libcurl libopenjp2
CFLAGS += -O2 -Wall -Wextra -Wno-unused-parameter \
	$(shell pkg-config --cflags $(PKGS))
LDLIBS += $(shell pkg-config --libs $(PKGS)) -lpthread -lm
PLATFORM ?= $(shell uname -sm | awk '{ \
	os = $$1 == "Darwin" ? "osx" : tolower($$1); \
	arch = $$2 ~ /^(x86_64|amd64)$$/ ? "amd64" : "arm64"; \
	print os "_" arch }')
VERSION = 0.3.0

# a loadable extension is the shared library plus duckdb's metadata footer:
# a wasm-style custom section header, eight 32-byte fields (last first) and
# 256 bytes left for a signature
.DEFAULT_GOAL = burnoff.duckdb_extension

# burnoff.sql, the macros, runs on load: each line a c string
burnoff.sql.h: burnoff.sql
	sed 's/\\/\\\\/g; s/"/\\"/g; s/.*/"&\\n"/' $< > $@

burnoff.duckdb_extension: burnoff.c burnoff.sql.h
	$(CC) $(CFLAGS) -Iinclude -shared -fPIC -o burnoff.so burnoff.c $(LDLIBS)
	{ cat burnoff.so; printf '\000\223\004\020duckdb_signature\200\004'; \
	  for f in "" "" "" C_STRUCT $(VERSION) v1.2.0 $(PLATFORM) 4; do \
	    printf '%s' "$$f"; head -c $$((32 - $${#f})) /dev/zero; done; \
	  head -c 256 /dev/zero; } > $@
	rm burnoff.so

# into ~/.duckdb/extensions, so `load burnoff` works from any directory
install: burnoff.duckdb_extension
	duckdb -unsigned -c "force install '$(CURDIR)/burnoff.duckdb_extension'"

clean:
	rm -f burnoff.duckdb_extension burnoff.sql.h
.PHONY: install clean

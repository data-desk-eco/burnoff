# DuckDB's stable C API (1.2+), libcurl and zlib. The detectors compile
# separately; S2 owns the JPEG 2000 decoder in src/j2k.c.
PKGS = libcurl
CFLAGS ?= -O2 -Wall -Wextra -Wno-unused-parameter
CFLAGS += $(shell pkg-config --cflags $(PKGS))
LDLIBS = $(shell pkg-config --libs $(PKGS)) -lz -lpthread -lm
SRC = src/burnoff.c src/s2.c src/s3.c
PLATFORM ?= $(shell uname -sm | awk '{ \
	os = $$1 == "Darwin" ? "osx" : tolower($$1); \
	arch = $$2 ~ /^(x86_64|amd64)$$/ ? "amd64" : "arm64"; \
	print os "_" arch }')
VERSION ?= $(shell git describe --tags --always 2>/dev/null || echo dev)
E = ext/burnoff.duckdb_extension

# the shared library plus duckdb's metadata footer: a wasm-style custom
# section header, eight 32-byte fields (last first) and 256 bytes left for a
# signature
$(E): $(SRC) src/burnoff.h src/j2k.c src/duckdb.h \
      src/duckdb_extension.h ext/burnoff.sql.h
	$(CC) $(CFLAGS) -Iext -shared -fPIC -fvisibility=hidden $(SRC) $(LDLIBS) \
	  -o ext/burnoff.so
	{ cat ext/burnoff.so; printf '\000\223\004\020duckdb_signature\200\004'; \
	  for f in "" "" "" C_STRUCT $(VERSION) v1.2.0 $(PLATFORM) 4; do \
	    printf '%s' "$$f"; head -c $$((32 - $${#f})) /dev/zero; done; \
	  head -c 256 /dev/zero; } > $@
	rm ext/burnoff.so

# the macros, run on load: each line a c string
ext/burnoff.sql.h: src/burnoff.sql
	@mkdir -p ext
	sed 's/\\/\\\\/g; s/"/\\"/g; s/.*/"&\\n"/' $< > $@

# loads, defines its macros and gives a failed row its error, offline; and
# a day granule is read not at all; and a granule's boxes in one chunk
# each get their own answer
test: $(E)
	duckdb -unsigned -c "install spatial; load spatial; \
	  load '$(CURDIR)/$(E)'; select \
	  coalesce(s2_detect('file:///none', 0, 0, 1, 1).error, error('no error')), \
	  if((select count(s2_detect(d, 0, 0, 1, 1).error) from (values (null)) \
	    t(d)) = 0, 'null', error('a null row has an error')), \
	  coalesce(s3_detect('file:///none', 0, 0, 1, 1).error, error('no error')), \
	  if(s3_detect('file:///S3A_SL_1_RBT____20250115T090000_x.SEN3', 0, 0, \
	    1, 1).error is null, 'day', error('read by day'))"
	duckdb -unsigned -c "install spatial; load spatial; load '$(CURDIR)/$(E)'; \
	  select if(count(r.error) = 3 and count(r.sza) = 3 and count(*) = 4, \
	    'one granule, three boxes, and a null row null field by field', \
	    error('boxes of a granule')) from (select s3_detect(d, 0, 0, 1, 1) r \
	    from (values ('file:///S3A_SL_1_RBT____20250115T210000_x.SEN3'), \
	    ('file:///S3A_SL_1_RBT____20250115T210000_x.SEN3'), (null), \
	    ('file:///S3A_SL_1_RBT____20250115T210000_x.SEN3')) t(d))"
	duckdb -unsigned -c "load spatial; load '$(CURDIR)/$(E)'; select \
	  if(s2_detect('file:///none', 0, 0, 1, 1, 'b12_min=oops').error \
	    = 'invalid threshold value', 'numeric thresholds', error('bad number')), \
	  if(s3_detect('file:///none', 0, 0, 1, 1, 'exact=2').error \
	    = 'exact must be 0 or 1', 'threshold bounds', error('bad flag'))"

# into ~/.duckdb/extensions, so `load burnoff` works from any directory
install: $(E)
	duckdb -unsigned -c "force install '$(CURDIR)/$(E)'"

clean:
	rm -rf ext

.PHONY: test install clean

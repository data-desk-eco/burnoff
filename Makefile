.PHONY: serve signal help

serve: signal
	@echo "http://localhost:8000  (signaling on :4444)"
	@npx serve web -l 8000

signal:
	@node signal-server.js &

help:
	@echo "make serve    - Start dev server on :8000 + signaling on :4444"
	@echo "make signal   - Start signaling server only on :4444"

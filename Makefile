.PHONY: serve help

serve:
	@echo "http://localhost:8000"
	@npx serve web -l 8000

help:
	@echo "make serve    - Start dev server on :8000"

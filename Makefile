CLOUD_RUN_SERVICE := burnoff-signaling
CLOUD_RUN_REGION  := europe-west2

.PHONY: serve signal deploy help

serve: signal
	@echo "http://localhost:8000  (signaling on :4444)"
	@npx serve web -l 8000

signal:
	@node signal/server.js &

deploy:
	gcloud run deploy $(CLOUD_RUN_SERVICE) \
		--source signal/ \
		--region $(CLOUD_RUN_REGION) \
		--allow-unauthenticated \
		--session-affinity \
		--min-instances 0 \
		--max-instances 1
	@echo ""
	@echo "Add this to web/index.html <head>:"
	@echo '  <meta name="signaling-url" content="wss://$(CLOUD_RUN_SERVICE)-HASH.$(CLOUD_RUN_REGION).run.app">'
	@echo ""
	@echo "Get the exact URL with: gcloud run services describe $(CLOUD_RUN_SERVICE) --region $(CLOUD_RUN_REGION) --format 'value(status.url)'"

help:
	@echo "make serve    - Dev server on :8000 + signaling on :4444"
	@echo "make signal   - Signaling server only"
	@echo "make deploy   - Deploy signaling server to Cloud Run"

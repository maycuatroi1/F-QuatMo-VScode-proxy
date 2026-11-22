# Summary runtime shipped with the proxy

Current engine source: `PhaseSUMMARY_2026-11-18.zip`, active `summary_tool/engine`.
Rule `phase-summary-3.1-2026-11-18` produces four report sections with no oral-exam
suggestions. `PROVENANCE.json` binds source/package hashes and deployment adaptations.
`forbidden.txt` is a required runtime asset copied into the image. Production keeps
the verified `scheduled-signin-v1` population rather than upstream activity-cluster
heuristics. See `../docs/summary-integration.md` for rollout, limitations and rollback.
The original Nov17 description below is historical and its byte-identity statement
no longer applies to the updated scientific engine.

This directory makes the existing PhaseSUMMARY CLI available in the proxy's
GitHub/Dokploy build context. The Dockerfile installs Python and system CA
certificates, copies only the CLI/engine into `/opt/summary-tool`, and checks CLI
imports during the build. No daemon, model weights or extra Python packages are
required by this CLI. Gemma is called through the configured external API.

`PROVENANCE.json` records the original and packaged SHA-256 for all eleven Python
files copied from `PhaseSUMMARY/summary_tool` on 2026-11-17. Eight research-engine
modules, including algorithms and prompts, are byte-identical. `generate_cli.py`
adds input checks before entering that unchanged pipeline; `engine/config.py`
and `engine/llm_client.py` remove embedded credential fallback, verify HTTPS,
reject redirects and use portable config paths. The additional
`engine/archive_security.py` streams ZIP validation and limits Linux worker memory.
The original research source was not edited. Any later algorithm/prompt update
must be reviewed explicitly and the provenance record updated with it.

Docker defaults:

```dotenv
SUMMARY_CLI_PATH=/opt/summary-tool/generate_cli.py
SUMMARY_PYTHON_BIN=/usr/bin/python3
SUMMARY_LLM_MODEL=gemma-4-26b
```

Dokploy runtime ENV can override these defaults. Existing `CUSTOM_API_KEY` is
used when no dedicated `SUMMARY_LLM_API_KEY` is set. Never put `.env`, API keys,
collected logs or production databases in this directory. The build-context
allowlist excludes them, along with Python caches and test files.

All generation remains manual through the existing proxy APIs. The adapter passes
an explicit input ZIP and private output directory; it does not use the pipeline's
legacy standalone default paths. Output is saved by the proxy and temporary job
files are cleaned by the existing adapter. Nothing here migrates/reconciles input
telemetry or modifies database schemas.

## Verification

With Python 3 installed, run from `quatmo-proxy`:

```text
python3 -B summary_tool/tests/test_cli.py
```

Eight tests use temporary synthetic ZIPs, disable LLM for generation, preserve
the input ZIP's SHA-256, check model/key precedence, reject unsafe/ambiguous
archives and verify TLS, redirect and Linux memory protections. All eight pass in
the network-disabled Alpine image; Windows skips the Linux-only memory test.
No real student record or credential is used. An end-to-end Bun adapter -> Python
-> stored reports/manifest smoke check also passes in the image.

`SUMMARY_MAX_CONCURRENT_JOBS` defaults to 1 per proxy process; occupied capacity
returns HTTP 429 before upload parsing or generation starts. The Python worker
receives only allowlisted model/runtime ENV, not JWT/admin/Redis/S3 credentials.
`SUMMARY_ENGINE_MEMORY_MB` defaults to 1024 (Linux virtual address space), and ZIP
limits use SUMMARY_MAX_ARCHIVE_BYTES (default 512 MiB) and SUMMARY_MAX_ARCHIVE_FILES
(default 50000), including nested snapshot content. Set the worker budget below the
actual container memory limit with headroom for Bun; this is not a load-test or
distributed-queue guarantee. Native binary overrides do not use Python's limiter.

# Changelog

Changes to qisiTV and its inherited release history are documented in this file.

## Unreleased

- Merged upstream v1.5.9 while preserving qisiTV branding, LikeAI, and local Agent integration; Cloudflare publishing is optional and requires the fork's own release configuration.
- Renamed the product, icons, local Agent tools, packages, and runtime identifiers to qisiTV while preserving existing local data and upstream attribution.
- Added LikeAI model support and a shared MCP / CLI interface for external local Agents.
- Built-in BeefAPI can be connected from the desktop app without pasting a key.
- Prepared the first audited public source snapshot.
- Added reproducible local builds, automated quality checks, and multi-architecture container publishing.
- Standardized the upstream public artifacts, runtime identifiers, documentation, and repository links.

## v1.5.9

- Validate reference image dimensions, aspect ratios, file sizes and audio/video duration using each model's configured capabilities before submitting.
- Preserve supported reference counts, resolutions and durations instead of silently dropping media or downgrading requested settings.
- Support local and inline reference audio for BeefAPI and native Ark channels, while retaining provider-specific audio-only rules.
- Show actionable reference conversion and request-size errors in both canvas nodes and task history, with safe diagnostics and no unsafe unchanged retries.

## v1.5.8

- Add a persistent light/dark switch to the workspace sidebar, with matching home, asset library, menus and settings surfaces.
- Restore canvas appearance controls with light, dark and custom modes; keep each canvas appearance independent from the workspace theme.
- New canvases follow the workspace theme unless an explicit default appearance is saved.

## v1.5.7

- Desktop update checks and downloads now use Cloudflare-hosted files, preserving signed manifests and package integrity verification.
- Publish immutable platform packages before switching the update feed, with verified downloads and protection against incomplete or older releases.
- Check Seedance reference audio total duration and explain gateway media validation failures with the affected clip and actionable limits.

## v1.5.6

- Validate Seedance reference audio/video duration before submission and preserve duration metadata for character voice samples.
- Explain material conversion failures with actionable duration limits and retain request identifiers for support.
- Keep existing task polling available and prevent unsafe resubmission while provider acceptance is uncertain.

## v1.5.5

- Desktop update checks and downloads now use the current user's static HTTP/HTTPS system proxy on macOS and Windows when no explicit environment proxy is configured.
- Keep a manual update check in the sidebar and show a retry action when checking fails, instead of hiding connection failures.
- Preserve proxy bypass rules, signed manifest verification and package integrity checks throughout redirected downloads.

## v1.5.4

- Generation failures now explain the cause and the next action across canvas nodes, task history and custom channels.
- Distinguish content moderation, account quota, provider billing, invalid parameters, rate limits, uncertain submissions and failed result downloads without guessing refunds or the offending input.
- Preserve safe error codes and request identifiers for support, including business errors returned with HTTP 200 and JSON errors inside media downloads.
- Prevent unsafe unchanged batch retries; edited prompts and reference media can be submitted as new attempts after moderation failures.
- Cover all 42 currently declared BeefAPI error codes with a shared frontend and backend regression contract.
- Improved the shared model picker with a viewport-safe, internally scrollable layout and consistent single-line model options.
- Removed redundant model icons, secondary descriptions, and stale option backgrounds from model selection UI.
- Restored native right-click paste behavior in canvas prompt editors and added regression coverage.
- Added regression coverage for generation output delivery, model picker overflow, and local generation error handling.
- Added a canonical local app update script to keep one installed qisiTV application instead of accumulating duplicate builds.

## v1.5.3

- Desktop builds show the installed version in the sidebar and check for published updates on startup.
- Signed updates can be downloaded in the app, then installed with an explicit restart while keeping local projects, assets, settings and connections.
- Pending canvas, director and timeline saves are checked before restarting; failed downloads or verification leave the current installation intact.
- Maintainers can build and publish signed macOS and Windows update packages from main. Existing installations need one manual upgrade to this version before in-app updates are available.

## v1.5.2

- Improved canvas node rendering and inline image cropping, annotation, and local redraw interactions.
- Rebuilt the recycle bin with a fixed two-row viewport, selection, recovery, and confirmed permanent deletion.
- Fixed project cover selection across media nodes and canvases, including fallbacks and centered empty placeholders.
- Added a short product demo and updated the README branding.

## v1.5.1

- Initial public upstream snapshot.
- Local-first AI video workspace with image, video, audio, text, asset, canvas, and model-channel workflows.
- BeefAPI remains a built-in local channel while its model catalog is discovered dynamically.

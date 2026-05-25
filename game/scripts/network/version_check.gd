extends Node

## Hits the GitHub releases API once and emits `update_available` when the
## local build is older than the latest published release. Failures (offline,
## API down, rate-limited) are swallowed silently - this check is best-effort
## and should never nag an offline player.
##
## The website at WEBSITE_URL hydrates its download links from the same API,
## so the popup can just deep-link the player there.

signal update_available(local_version: String, latest_version: String)
signal check_complete

const RELEASES_API := "https://api.github.com/repos/sean-reid/clowns-and-mimes/releases/latest"
const WEBSITE_URL := "https://sean-reid.github.io/clowns-and-mimes/"
const REQUEST_TIMEOUT_S := 5.0

func check() -> void:
	var http := HTTPRequest.new()
	add_child(http)
	http.timeout = REQUEST_TIMEOUT_S
	http.request_completed.connect(_on_response.bind(http))
	var headers := PackedStringArray(["Accept: application/vnd.github+json"])
	var err: int = http.request(RELEASES_API, headers, HTTPClient.METHOD_GET)
	if err != OK:
		http.queue_free()
		check_complete.emit()

func _on_response(
	_result: int,
	response_code: int,
	_headers: PackedStringArray,
	body: PackedByteArray,
	http: HTTPRequest,
) -> void:
	http.queue_free()
	if response_code < 200 or response_code >= 300:
		check_complete.emit()
		return
	var parsed: Variant = JSON.parse_string(body.get_string_from_utf8())
	if typeof(parsed) != TYPE_DICTIONARY:
		check_complete.emit()
		return
	var tag: String = parsed.get("tag_name", "")
	if tag.is_empty():
		check_complete.emit()
		return
	var latest: String = tag.lstrip("v")
	var local: String = local_version()
	if _is_newer(latest, local):
		update_available.emit(local, latest)
	check_complete.emit()

static func local_version() -> String:
	var v: Variant = ProjectSettings.get_setting("application/config/version", "0.0.0")
	return str(v)

## Pure comparison helper. Returns true iff `candidate` is strictly newer than
## `current` by SemVer rules (major.minor.patch, ints compared left to right).
## Non-numeric components or extra suffixes are tolerated and compared
## lexicographically as a tiebreaker so a prerelease tag does not falsely
## flag an update.
static func _is_newer(candidate: String, current: String) -> bool:
	var a: Array = _split_version(candidate)
	var b: Array = _split_version(current)
	var n: int = maxi(a.size(), b.size())
	for i in n:
		var ai: int = int(a[i]) if i < a.size() else 0
		var bi: int = int(b[i]) if i < b.size() else 0
		if ai > bi:
			return true
		if ai < bi:
			return false
	return false

static func _split_version(v: String) -> Array:
	var core: String = v.split("-", true, 1)[0]
	var parts: Array = []
	for piece in core.split("."):
		parts.append(piece)
	return parts

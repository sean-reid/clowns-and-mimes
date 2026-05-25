extends "res://tests/test_case.gd"

const VersionCheck := preload("res://scripts/network/version_check.gd")

func test_is_newer_basic_semver() -> void:
	assert_true(VersionCheck._is_newer("0.3.2", "0.3.1"), "patch bump")
	assert_true(VersionCheck._is_newer("0.4.0", "0.3.99"), "minor bump beats patch")
	assert_true(VersionCheck._is_newer("1.0.0", "0.99.99"), "major bump beats minor")

func test_is_newer_equal_is_not_newer() -> void:
	assert_false(VersionCheck._is_newer("0.3.1", "0.3.1"), "equal versions")

func test_is_newer_older_is_not_newer() -> void:
	assert_false(VersionCheck._is_newer("0.3.0", "0.3.1"), "older patch")
	assert_false(VersionCheck._is_newer("0.2.99", "0.3.0"), "older minor")

func test_is_newer_handles_short_versions() -> void:
	# "1.0" should compare equal to "1.0.0", and "1.0.1" is newer than "1.0".
	assert_false(VersionCheck._is_newer("1.0", "1.0.0"), "missing trailing zero")
	assert_true(VersionCheck._is_newer("1.0.1", "1.0"), "patch over abbreviated")

func test_is_newer_strips_prerelease_suffix() -> void:
	# `_split_version` keeps only the major.minor.patch core, so "0.3.1-rc1"
	# compares as 0.3.1 - prerelease tags don't falsely flag an update.
	assert_false(VersionCheck._is_newer("0.3.1-rc1", "0.3.1"), "prerelease vs release")

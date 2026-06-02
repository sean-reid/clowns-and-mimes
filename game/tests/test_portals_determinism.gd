extends "res://tests/test_case.gd"

## Cross-language portal-geometry determinism. Reads the fixture written by
## scripts/gen-portals-fixture.ts and asserts the GDScript OfflinePortals builds
## the same pair (mouths, emergence points, exit yaws) as the canonical TS
## buildPortalPair, replaying the identical rng sequence for the exit-wall pick.

const OfflinePortals := preload("res://scripts/offline_portals.gd")
const GridMaze := preload("res://scripts/grid_maze.gd")
const TopologyFactory := preload("res://scripts/topology/topology_factory.gd")

const FIXTURE_PATH := "res://tests/fixtures/portals_snapshot.json"
const TOLERANCE := 0.01

func _load_fixture() -> Dictionary:
	var file := FileAccess.open(FIXTURE_PATH, FileAccess.READ)
	if file == null:
		assert_true(false, "fixture missing - run `pnpm gen:portals-fixture`")
		return {}
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	file.close()
	return parsed if typeof(parsed) == TYPE_DICTIONARY else {}

func _assert_vec(got: Vector3, ex: Dictionary, label: String) -> void:
	assert_approx(got.x, float(ex.x), TOLERANCE, "%s x" % label)
	assert_approx(got.z, float(ex.z), TOLERANCE, "%s z" % label)

func _assert_scenario(sc: Dictionary, seq: Array) -> void:
	var name: String = sc.name
	var topo := TopologyFactory.from_string(sc.topology)
	var walls: Array = GridMaze.generate(int(sc.seed), sc.topology)
	var counter := [0]
	var rng := func() -> float:
		var v: float = float(seq[counter[0] % seq.size()])
		counter[0] += 1
		return v
	var geom: Dictionary = OfflinePortals.build_portal_pair(
		float(sc.origin.x), float(sc.origin.z), float(sc.yaw), walls, topo, rng
	)
	assert_false(geom.is_empty(), "%s: built a pair" % name)
	var ex: Dictionary = sc.geom
	_assert_vec(geom.a, ex.a, "%s a" % name)
	_assert_vec(geom.b, ex.b, "%s b" % name)
	_assert_vec(geom.a_exit, ex.aExit, "%s a_exit" % name)
	_assert_vec(geom.b_exit, ex.bExit, "%s b_exit" % name)
	assert_approx(geom.a_exit_yaw, float(ex.aExitYaw), TOLERANCE, "%s a_exit_yaw" % name)
	assert_approx(geom.b_exit_yaw, float(ex.bExitYaw), TOLERANCE, "%s b_exit_yaw" % name)

func test_portals_match_fixture() -> void:
	var fixture := _load_fixture()
	if fixture.is_empty():
		return
	var seq: Array = fixture.rngSeq
	var scenarios: Array = fixture["scenarios"]
	assert_true(scenarios.size() > 0, "fixture has scenarios")
	for sc in scenarios:
		_assert_scenario(sc, seq)

extends "res://tests/test_case.gd"

## Cross-language projectile determinism. Reads the fixture written by
## scripts/gen-projectiles-fixture.ts and asserts the GDScript OfflineProjectiles
## flies + collides identically to the canonical TS stepProjectiles: same hits
## (victim ids / terminations) and the same surviving positions after N ticks.

const OfflineProjectiles := preload("res://scripts/offline_projectiles.gd")
const GridMaze := preload("res://scripts/grid_maze.gd")
const TopologyFactory := preload("res://scripts/topology/topology_factory.gd")

const FIXTURE_PATH := "res://tests/fixtures/projectiles_snapshot.json"
const TOLERANCE := 0.001

func _load_fixture() -> Dictionary:
	var file := FileAccess.open(FIXTURE_PATH, FileAccess.READ)
	if file == null:
		assert_true(false, "fixture missing - run `pnpm gen:projectiles-fixture`")
		return {}
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	file.close()
	return parsed if typeof(parsed) == TYPE_DICTIONARY else {}

func _vec(d: Dictionary) -> Vector3:
	return Vector3(float(d.x), float(d.y), float(d.z))

func _assert_scenario(sc: Dictionary, dt: float, ticks: int) -> void:
	var name: String = sc.name
	var topo := TopologyFactory.from_string(sc.topology)
	var walls: Array = [] if int(sc.seed) < 0 else GridMaze.generate(int(sc.seed), sc.topology)
	var owner := {"id": sc.owner.id, "team": sc.owner.team, "position": _vec(sc.owner.position)}
	var targets: Array = []
	for t in sc.targets:
		targets.append(
			{"id": t.id, "team": t.team, "position": _vec(t.position), "frozen": t.get("frozen", false)}
		)
	var p0 := OfflineProjectiles.spawn_projectile(owner, _vec(sc.dir), "p0", 0, 0)
	assert_false(p0.is_empty(), "%s: spawned" % name)
	var live: Array = [p0]
	var all_hits: Array = []
	var frames: int = 0
	var last_frame: Array = []
	for i in ticks:
		if live.is_empty():
			break
		var res: Dictionary = OfflineProjectiles.step_projectiles(
			live,
			targets,
			{
				"dt": dt,
				"now_ms": i * 1000.0 * dt,
				"walls": walls,
				"topology": topo,
				"hit_radius": OfflineProjectiles.PROJECTILE_HIT_RADIUS,
				"saved_at": {},
				"unfreeze_grace_ms": 0,
			}
		)
		for h in res.hits:
			all_hits.append(h)
		live = res.survivors
		last_frame = live
		frames += 1

	assert_eq(frames, int(sc.ticksLived), "%s: ticks lived" % name)
	# Hits: same count + same victim ids (in order).
	var ex_hits: Array = sc.hits
	assert_eq(all_hits.size(), ex_hits.size(), "%s: hit count" % name)
	for i in mini(all_hits.size(), ex_hits.size()):
		var got_victim: String = all_hits[i].get("victim_id", "")
		var ex_victim: String = ex_hits[i].get("victimId", "")
		assert_eq(got_victim, ex_victim, "%s: hit %d victim" % [name, i])
	# Final surviving positions.
	var ex_final: Array = sc.finalFrame
	assert_eq(last_frame.size(), ex_final.size(), "%s: survivor count" % name)
	for i in mini(last_frame.size(), ex_final.size()):
		var gp: Vector3 = last_frame[i].position
		var ep: Dictionary = ex_final[i]
		assert_approx(gp.x, float(ep.x), TOLERANCE, "%s: survivor %d x" % [name, i])
		assert_approx(gp.y, float(ep.y), TOLERANCE, "%s: survivor %d y" % [name, i])
		assert_approx(gp.z, float(ep.z), TOLERANCE, "%s: survivor %d z" % [name, i])

func test_projectiles_match_fixture() -> void:
	var fixture := _load_fixture()
	if fixture.is_empty():
		return
	var dt: float = float(fixture.dt)
	var ticks: int = int(fixture.ticks)
	var scenarios: Array = fixture["scenarios"]
	assert_true(scenarios.size() > 0, "fixture has scenarios")
	for sc in scenarios:
		_assert_scenario(sc, dt, ticks)

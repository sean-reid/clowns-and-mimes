extends "res://tests/test_case.gd"

const GeneratorScript := preload("res://scripts/username_generator.gd")
const SharedConstants := preload("res://scripts/shared_constants.gd")

func test_generated_names_have_expected_shape() -> void:
	var generator: Node = Node.new()
	generator.set_script(GeneratorScript)
	for _i in range(20):
		var generated_name: String = generator.generate()
		assert_true(generated_name.length() >= 5, "name should be non-trivial")
		assert_true(generated_name == generated_name.strip_edges(), "name should not have surrounding whitespace")
		var last_three: String = generated_name.substr(generated_name.length() - 3, 3)
		assert_true(last_three.is_valid_int(), "last three chars should be digits: %s" % generated_name)
	generator.free()

func test_word_lists_come_from_shared_constants() -> void:
	assert_true(SharedConstants.NAME_ADJECTIVES.size() > 0, "adjectives should be populated from shared constants")
	assert_true(SharedConstants.NAME_NOUNS.size() > 0, "nouns should be populated from shared constants")

func test_word_lists_have_no_duplicates() -> void:
	for list_name in ["NAME_ADJECTIVES", "NAME_NOUNS"]:
		var words: Array = SharedConstants.get(list_name)
		var seen := {}
		for word in words:
			assert_false(seen.has(word), "%s has duplicate: %s" % [list_name, word])
			seen[word] = true

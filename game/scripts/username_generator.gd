extends Node

## Procedural username generator. Pairs a silly adjective with a clown/mime
## themed noun and a three-digit suffix. Domain size: ADJECTIVES x NOUNS x 1000.

const ADJECTIVES := [
	"Silent", "Painted", "Loud", "Floppy", "Crooked", "Bashful", "Velvet",
	"Hushed", "Ruffled", "Striped", "Glossy", "Pale", "Sneaky", "Whiskered",
	"Brittle", "Tipsy", "Polka", "Wobbly", "Crinkled", "Powdered",
	"Squeaky", "Tufted", "Knobbly", "Frilly", "Wonky", "Boggled",
	"Plucky", "Drooping", "Frazzled", "Soggy", "Greasy", "Jaunty",
	"Saggy", "Lopsided", "Petite", "Stilted", "Drippy", "Mottled",
	"Googly", "Spangled", "Befuddled", "Twitchy", "Mournful", "Limpid",
	"Smudged", "Curdled", "Cracked", "Bumbling", "Threadbare", "Daffy",
	"Dusty", "Garish", "Hapless", "Wistful", "Brassy", "Maudlin",
	"Frumpy", "Yawning", "Stooped", "Vexed", "Spotty", "Lurching",
	"Foggy", "Crumbly",
	"Goofy", "Zany", "Wacky", "Kooky", "Loopy", "Nutty",
	"Bonkers", "Clumsy", "Giddy", "Madcap", "Cockeyed", "Harebrained",
	"Addled", "Ditzy", "Screwball", "Cuckoo", "Jumbled", "Galumphing",
	"Bamboozled", "Slapstick",
]

const NOUNS := [
	"Bozo", "Coulrophobe", "Pierrot", "Harlequin", "Buffoon", "Jester",
	"Marceau", "Tramp", "Auguste", "Whiteface", "Carnie", "Pagliacci",
	"Punchinello", "Hopo", "Cake", "Honk", "Greasepaint", "Stripes",
	"Tear", "Glove",
	"Wig", "Nose", "Shoe", "Banana", "Pinwheel", "Smile",
	"Frown", "Lapel", "Pocket", "Hatband", "Cravat", "Suspender",
	"Bowtie", "Trumpet", "Kazoo", "Squirt", "Ladder", "Bucket",
	"Pratfall", "Cartwheel", "Tightrope", "Unicycle", "Confetti", "Crumpet",
	"Boutonniere", "Mistletoe", "Marionette", "Glissando", "Pantomime", "Vaudeville",
	"Curtain", "Footlight", "Spotlight", "Soliloquy", "Pirouette", "Maskmaker",
	"Topiary", "Sashay", "Gambol", "Tumbler", "Patter", "Whoopee",
	"Mime", "Clown",
	"Zanni", "Pulcinella", "Brighella", "Colombina", "Pantalone", "Scaramuccia",
	"Dottore", "Capitano", "Innamorato", "Lazzo", "Burla", "Maschera",
	"Carnevale", "Tarantella", "Saltarello", "Serenata", "Gondola", "Pizzicato",
	"Cannoli", "Biscotto",
]

func generate() -> String:
	var adj: String = ADJECTIVES[randi() % ADJECTIVES.size()]
	var noun: String = NOUNS[randi() % NOUNS.size()]
	var num := randi() % 1000
	return "%s%s%03d" % [adj, noun, num]

func combinations() -> int:
	return ADJECTIVES.size() * NOUNS.size() * 1000

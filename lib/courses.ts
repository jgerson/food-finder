// Course for each of the 101 Food-101 dishes. Food-101 only labels the dish, so this grouping is ours;
// it gives search a filterable attribute. Used by the ingest script and by the filter chips in the UI.

export const COURSES = ["main", "starter", "breakfast", "dessert"] as const;
export type Course = (typeof COURSES)[number];

export const COURSE_LABELS: Record<Course, string> = {
  main: "Mains",
  starter: "Starters & sides",
  breakfast: "Breakfast",
  dessert: "Desserts",
};

const DESSERT = [
  "apple_pie", "baklava", "beignets", "bread_pudding", "cannoli", "carrot_cake", "cheesecake", "chocolate_cake",
  "chocolate_mousse", "churros", "creme_brulee", "cup_cakes", "donuts", "frozen_yogurt", "ice_cream", "macarons",
  "panna_cotta", "red_velvet_cake", "strawberry_shortcake", "tiramisu",
];

const BREAKFAST = [
  "breakfast_burrito", "eggs_benedict", "french_toast", "huevos_rancheros", "omelette", "pancakes", "waffles",
];

const STARTER = [
  "beef_carpaccio", "beef_tartare", "beet_salad", "bruschetta", "caesar_salad", "caprese_salad", "ceviche",
  "cheese_plate", "chicken_wings", "clam_chowder", "crab_cakes", "deviled_eggs", "dumplings", "edamame", "escargots",
  "falafel", "foie_gras", "french_fries", "french_onion_soup", "fried_calamari", "garlic_bread", "greek_salad",
  "guacamole", "gyoza", "hot_and_sour_soup", "hummus", "lobster_bisque", "miso_soup", "mussels", "nachos",
  "onion_rings", "oysters", "poutine", "samosa", "seaweed_salad", "spring_rolls", "takoyaki", "tuna_tartare",
];

const BY_LABEL = new Map<string, Course>([
  ...DESSERT.map((l) => [l, "dessert"] as const),
  ...BREAKFAST.map((l) => [l, "breakfast"] as const),
  ...STARTER.map((l) => [l, "starter"] as const),
]);

/** Course for a Food-101 label; every dish not listed above is a main. */
export function courseOf(label: string): Course {
  return BY_LABEL.get(label) ?? "main";
}

/** "eggs_benedict" -> "Eggs benedict" */
export function dishName(label: string): string {
  const s = label.replaceAll("_", " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

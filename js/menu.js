// The restaurant's menu. Add a dish here and it appears in the list with its own 3D / AR preview.
//   model: GLB in models/ (meters, Y up, standing on y = 0 → shown at real size in AR)
//   image: card picture in images/
//   scanned: true for dishes 3D-scanned from the real food (dish_scanner)

export const RESTAURANT = {
  name: "AR Menu",
  tagline: "See every dish on your table before you order",
  currency: "$",
};

export const CATEGORIES = [
  {
    id: "burgers",
    name: "Burgers",
    dishes: [
      {
        id: "classic-cheeseburger",
        name: "Classic Cheeseburger",
        description: "Flame-grilled beef, cheddar, crisp lettuce, tomato, red onion and pickles on a toasted sesame bun.",
        price: 9.5,
        model: "models/classic_cheeseburger.glb",
        image: "images/classic_cheeseburger.png",
        size: "26 cm plate · 9 cm tall",
        tags: ["Bestseller"],
      },
      {
        id: "crispy-chicken",
        name: "Crispy Chicken Burger",
        description: "Buttermilk fried chicken breast, garlic mayo, shredded lettuce and pickles on a brioche bun.",
        price: 10.5,
        model: "models/crispy_chicken.glb",
        image: "images/crispy_chicken.png",
        size: "26 cm plate · 8.5 cm tall",
        tags: [],
      },
      {
        id: "double-bacon",
        name: "Double Bacon Burger",
        description: "Two beef patties, double cheddar, smoky bacon, lettuce, pickles and ketchup.",
        price: 13.5,
        model: "models/double_bacon.glb",
        image: "images/double_bacon.png",
        size: "26 cm plate · 10.5 cm tall",
        tags: ["Big appetite"],
      },
      {
        id: "sesame-bun",
        name: "Sesame Bun",
        description: "Freshly baked sesame bun — 3D-scanned from our kitchen, so what you see is exactly what you get.",
        price: 2.5,
        model: "models/sesame_bun.glb",
        image: "images/sesame_bun.png",
        size: "28 cm plate · 10 cm tall",
        tags: ["Real 3D scan"],
        scanned: true,
      },
    ],
  },
];

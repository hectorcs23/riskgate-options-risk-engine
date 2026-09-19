import nextVitals from "eslint-config-next/core-web-vitals";

const config = [
  {
    ignores: [".next/**", "node_modules/**", "docs/**", "prisma/dev.db*", "options-strategy-bot/**"]
  },
  ...nextVitals,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/set-state-in-effect": "off"
    }
  }
];

export default config;

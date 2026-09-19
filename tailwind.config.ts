import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#17201c",
        field: "#f5f7ef",
        moss: "#4f6f52",
        amber: "#b98223",
        rust: "#ad4c32",
        mist: "#e8eee2"
      },
      boxShadow: {
        soft: "0 12px 34px rgba(23, 32, 28, 0.08)"
      }
    }
  },
  plugins: [require("@tailwindcss/forms")]
};

export default config;

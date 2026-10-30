// app.tsx imports app.css for its side effect; bb plugin build bundles it
// into dist/app.css after the Tailwind utilities.
declare module "*.css";

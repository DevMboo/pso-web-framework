// Runs before first paint (loaded synchronously in <head>) so the saved or system theme never flashes.
(function () {
  var t = null;
  try { t = localStorage.getItem("pso-studio-theme"); } catch (e) { /* storage blocked */ }
  if (t !== "light" && t !== "dark") t = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.theme = t;
})();

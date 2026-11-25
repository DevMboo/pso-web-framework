(function () {
  var theme = "dark";
  try {
    var saved = localStorage.getItem("pso-theme");
    if (saved === "light" || saved === "dark") theme = saved;
    else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) theme = "light";
  } catch (e) { /* storage unavailable: use the default */ }
  document.documentElement.setAttribute("data-theme", theme);
})();

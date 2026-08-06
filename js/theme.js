(() => {
  const STORAGE_KEY = "foxridge-theme";
  const DARK = "dark";
  const LIGHT = "light";

  function storedTheme() {
    try {
      return localStorage.getItem(STORAGE_KEY) === DARK ? DARK : LIGHT;
    } catch {
      return LIGHT;
    }
  }

  let theme = storedTheme();
  document.documentElement.dataset.theme = theme;

  function syncControls() {
    const nextTheme = theme === DARK ? LIGHT : DARK;
    const label = `Switch to ${nextTheme} mode`;

    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", String(theme === LIGHT));
      button.title = label;

      const icon = button.querySelector("[data-theme-icon]");
      const text = button.querySelector("[data-theme-label]");
      if (icon) icon.textContent = theme === DARK ? "☀" : "☾";
      if (text) text.textContent = label;
    });
  }

  function setTheme(nextTheme, persist = true) {
    theme = nextTheme === LIGHT ? LIGHT : DARK;
    document.documentElement.dataset.theme = theme;

    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, theme);
      } catch {
        // The theme still works for this page when storage is unavailable.
      }
    }

    syncControls();
    window.dispatchEvent(new CustomEvent("foxridge:themechange", {
      detail: { theme },
    }));
  }

  function setup() {
    syncControls();
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        setTheme(theme === DARK ? LIGHT : DARK);
      });
    });
    window.dispatchEvent(new CustomEvent("foxridge:themechange", {
      detail: { theme },
    }));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup, { once: true });
  } else {
    setup();
  }
})();

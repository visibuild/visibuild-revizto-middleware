// Tiny progressive-enhancement helpers. Kept in a static file (not inline) so the
// Content-Security-Policy can forbid inline scripts. Everything here is optional:
// without JavaScript every page still works, just less comfortably.
(function () {
  // Rewrite server-rendered <time data-dt> timestamps to the device's local
  // timezone (the server can't know the viewer's zone). Falls back gracefully:
  // without JS, the AU-timezone text rendered by the server is shown as-is.
  document.querySelectorAll("time[data-dt]").forEach(function (el) {
    var d = new Date(el.getAttribute("datetime"));
    if (!isNaN(d.getTime())) {
      el.textContent = d.toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
    }
  });

  document.addEventListener("click", function (e) {
    var target = e.target;

    // Select all / clear buttons: data-select="all|none" data-target="<name>"
    var sel = target.closest("[data-select]");
    if (sel) {
      var name = sel.getAttribute("data-target");
      var check = sel.getAttribute("data-select") === "all";
      document
        .querySelectorAll('input[type="checkbox"][name="' + name + '"]')
        .forEach(function (cb) { cb.checked = check; });
      return;
    }

    // Whole-row click navigation: <tr data-href="..."> (ignore clicks on links).
    var row = target.closest("[data-href]");
    if (row && !target.closest("a")) {
      window.location.href = row.getAttribute("data-href");
    }
  });

  // Ask before anything destructive or externally visible: deleting a pair,
  // disconnecting Revizto, removing a webhook. The confirm text lives on the
  // form, so the markup stays declarative.
  document.addEventListener("submit", function (e) {
    var form = e.target.closest("form[data-confirm]");
    if (!form) return;
    if (!window.confirm(form.getAttribute("data-confirm"))) {
      e.preventDefault();
    }
  });

  // Auto-submit the enclosing form when a [data-autosubmit] control changes –
  // used by the Revizto licence picker, which has to reload to list its projects.
  document.addEventListener("change", function (e) {
    var el = e.target.closest("[data-autosubmit]");
    if (el && el.form) el.form.submit();
  });
})();

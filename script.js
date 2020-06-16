(() => {
  let OUTH_TOKEN;

  try {
    OUTH_TOKEN = localStorage.getItem("token");
    $("#token input").value = OUTH_TOKEN;
  } catch (err) {}

  const urlRegex = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:tree|blob)\/([\w.-]+)\/(.+)/;

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => ctx.querySelectorAll(sel);

  const list = $("#items");
  const form = $("#form");
  const logs = $("#logs");
  const editButton = $("#edit");
  const ONE_HOUR = 60 * 60 * 1000;

  new idbKeyval.Store();

  function getParams(url) {
    if (!urlRegex.test(url)) throw new Error("Invalid URL");
    const [_, owner, name, branch, path] = url.match(urlRegex);
    return { owner, name, branch, path };
  }

  const api = {
    rateLimit(headers) {
      return {
        total: headers.get("X-RateLimit-Limit"),
        left: headers.get("X-RateLimit-Remaining"),
      };
    },
    async v3(owner, name, branch, path) {
      const api = new URL(
        `https://api.github.com/repos/${owner}/${name}/commits`,
      );
      api.searchParams.set("sha", branch);
      api.searchParams.set("path", path);
      const response = await fetch(api);

      const [commit] = await response.json();
      const { sha, html_url: link } = commit;
      const {
        message,
        committer: { date },
      } = commit.commit;
      const rateLimit = this.rateLimit(response.headers);

      return { sha, date, message, link, rateLimit };
    },

    async v4(owner, name, branch, path, token) {
      const query =
        `{ repository(owner: "${owner}", name: "${name}") {` +
        `ref(qualifiedName: "refs/heads/${branch}") {` +
        `target { ... on Commit { history(first: 1, path: "${path}") {` +
        "edges{node{ sha: oid, date: committedDate, message, link: url }}}}}}}}";
      const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `bearer ${token}`,
        },
        body: JSON.stringify({ query }),
      });

      const { data } = await response.json();
      const result = data.repository.ref.target.history.edges[0].node;
      const rateLimit = this.rateLimit(response.headers);

      return { ...result, rateLimit };
    },
  };

  function renderItem(url, data) {
    const id = new URL(url).pathname;
    const item = document.createElement("li", { is: "last-commit-item" });
    item.setAttribute("id", id);
    const { _time, ...dataset } = data;
    Object.assign(item.dataset, dataset, { url });
    _time && Object.assign(item.dataset, { lastchecked: _time });

    if (document.getElementById(id)) {
      const oldItem = document.getElementById(id);
      if (data.date != oldItem.dataset.date) {
        item.classList.add("modified");
      }
      oldItem.replaceWith(item);
    } else {
      list.prepend(item);
    }
    return item;
  }

  async function getData(url) {
    const { owner, name, branch, path } = getParams(url);
    const args = [owner, name, branch, path];
    const { rateLimit, ...result } = OUTH_TOKEN
      ? await api.v4(...args, OUTH_TOKEN)
      : await api.v3(...args);
    idbKeyval.set(url, { ...result, _time: Date.now() });

    const percentLeft = (rateLimit.left * 100) / rateLimit.total;
    $("#limit").style.width = `${percentLeft}%`;

    return result;
  }

  async function addItem(url) {
    const data = await getData(url);
    renderItem(url, data);
  }

  customElements.define(
    "last-commit-item",
    class extends HTMLLIElement {
      constructor() {
        super();
        this.template = $("#item-template").content.cloneNode(true);
      }

      connectedCallback() {
        this.renderTitle();
        this.renderCommit();
        this.renderTime();
        this.appendChild(this.template);
      }

      disconnectedCallback() {
        timeago.cancel($("time", this.template));
      }

      renderTitle() {
        const { url } = this.dataset;

        const link = $("h3 a", this.template);
        link.href = url;

        const { owner, name, branch, path } = getParams(url);
        const [elRepo, elBranch, elPath] = $$("span", link);
        elRepo.textContent = `${owner}/${name}`;
        elBranch.textContent = branch;
        elPath.textContent = `${path}`;
      }

      renderCommit() {
        const { sha, link, message } = this.dataset;
        const hash = $("p a", this.template);
        hash.href = link;
        hash.textContent = sha.substr(0, 8);
        $("p span", this.template).textContent = message;
        $("p span", this.template).title = message;
      }

      renderTime() {
        const date = new Date(this.dataset.date);
        const lastChecked = new Date(
          parseInt(this.dataset.lastchecked, 10) || Date.now(),
        );
        const timeEl = $("time", this.template);
        timeEl.setAttribute("datetime", date.toISOString());
        timeago.render(timeEl);
        timeEl.title = `Modified: ${date}.\nLast checked: ${lastChecked}`;
      }
    },
    { extends: "li" },
  );

  form.addEventListener("submit", async ev => {
    ev.preventDefault();
    const input = form.input;
    const url = input.value;

    form.classList.add("loading");
    try {
      await addItem(url);
    } catch (error) {
      input.setCustomValidity("foo");
    } finally {
      form.classList.remove("loading");
      setTimeout(() => {
        input.setCustomValidity("");
        input.value = "";
      }, 1000);
    }
  });

  $("#token").addEventListener("submit", function (ev) {
    ev.preventDefault();
    OUTH_TOKEN = this.token.value;
    localStorage.setItem("token", OUTH_TOKEN);
  });

  list.addEventListener("click", async ev => {
    if (ev.target.localName !== "button") return;

    const el = ev.target;
    const item = el.closest("li");
    const url = item.dataset.url;

    if (el.classList.contains("remove")) {
      item.remove();
      idbKeyval.del(url);
    } else if (el.classList.contains("refresh")) {
      try {
        item.classList.add("loading");
        await addItem(url);
      } catch (error) {
        // nothing
      } finally {
        item.classList.remove("loading");
      }
    } else if (el.classList.contains("self-link")) {
      location.hash = item.id;
    }
  });

  editButton.addEventListener("click", () => {
    document
      .querySelectorAll("li article .buttons")
      .forEach(el => el.classList.toggle("hidden"));
  });

  async function onReady() {
    const url = new URL(window.location.href);
    const params = {
      update: url.searchParams.has("update"),
      hash: window.location.hash,
      auto: url.searchParams.has("auto")
        ? Math.max(parseInt(url.searchParams.get("auto"), 10), 10)
        : 0,
    };
    if (params.update) {
      addLog(`Updating all saved entries. (Based on ?update flag)`);
    }

    renderAll();

    if (params.hash) {
      try {
        const urls = new Set(await idbKeyval.keys());
        const path = params.hash.replace(/^#/, "");
        const url = new URL(path, "https://github.com").href;
        if (urls.has(url)) return;
        addLog(`Adding an entry for ${url}. (Based on #fragment)`);
        await addItem(url);
      } catch (err) {
        addLog(err.message);
        console.error(err);
      } finally {
        history.replaceState(null, null, location.pathname);
      }
    }

    if (params.auto) {
      addLog(
        `Auto-updating every ${params.auto} seconds. (Based on ?auto option)`,
      );
      setInterval(() => {
        params.update = true;
        renderAll();
      }, params.auto * 1000);
    }

    // jump to element
    if (location.hash) {
      location.href = location.hash;
    }

    async function renderAll() {
      const urls = await idbKeyval.keys();
      const promises = urls.map(url => idbKeyval.get(url));
      const data = await Promise.all(promises);
      for (let i = 0; i < urls.length; ++i) {
        const item = renderItem(urls[i], data[i]);
        if (params.update || Date.now() - data[i]._time > ONE_HOUR) {
          item.classList.add("loading");
          addItem(urls[i]);
        }
      }
    }
  }

  function addLog(text) {
    logs.appendChild(document.createTextNode(" - " + text + "\n"));
  }

  onReady();
})();


(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // DEMO: embedded Ticketmaster Discovery API key
  const TICKETMASTER_API_KEY = "JuJq9Z9nl9uPpOX3Axrz34iLzkcNJ1Aa";

  const money = (n) =>
    n.toLocaleString(undefined, { style: "currency", currency: "USD" });

  function setStoredOrder(order) {
    localStorage.setItem("raincheck:lastOrder", JSON.stringify(order));
  }
  function getStoredOrder() {
    try { return JSON.parse(localStorage.getItem("raincheck:lastOrder") || "null"); }
    catch { return null; }
  }

  function setSelectedEvent(evt) {
    sessionStorage.setItem("raincheck:selectedEvent", JSON.stringify(evt));
  }
  function getSelectedEvent() {
    try { return JSON.parse(sessionStorage.getItem("raincheck:selectedEvent") || "null"); }
    catch { return null; }
  }

  function isoToNice(iso) {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso || "");
      return d.toLocaleString(undefined, {
        weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit"
      });
    } catch {
      return String(iso || "");
    }
  }

  
  function pickBestImage(images){
    // Ticketmaster returns multiple sizes/ratios. Prefer 16_9, wider + reasonably large.
    if (!Array.isArray(images) || images.length === 0) return "";
    const scored = images.map(im => {
      const ratio = (im.ratio || "").toString();
      const w = Number(im.width || 0);
      const h = Number(im.height || 0);
      let score = 0;
      if (ratio === "16_9") score += 40;
      else if (ratio === "4_3") score += 20;
      else score += 10;
      score += Math.min(60, Math.round(w / 40)); // bigger is better up to a point
      if (im.url) score += 10;
      return { im, score };
    }).sort((a,b)=>b.score-a.score);
    return scored[0]?.im?.url || images[0]?.url || "";
  }

  function inferOutdoorFromVenueName(name) {
    if (!name) return true;
    const indoorHints = ["arena", "center", "centre", "theatre", "theater", "hall", "auditorium"];
    const n = name.toLowerCase();
    return !indoorHints.some(h => n.includes(h));
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function toTicketmasterIso(d) {
  // Ticketmaster requires YYYY-MM-DDTHH:mm:ssZ (no milliseconds)
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function fetchTicketmasterEvents({ keyword, city, startDate, endDate, page = 0, seededKeyword = "" }) {
    const params = new URLSearchParams();
    params.set("apikey", TICKETMASTER_API_KEY);
    params.set("size", "30");
    params.set("sort", "date,asc");

    // Only apply a random keyword when the user hasn't provided any filters.
    const seedOptions = ["music","festival","comedy","sports","theatre","rock","pop"];
    const hasUserKeyword = (keyword && keyword.trim());
    const hasUserCity = (city && city.trim());
    const hasUserDates = !!(startDate || endDate);
    if (hasUserKeyword) params.set("keyword", keyword.trim());
    else if (!hasUserCity && !hasUserDates) {
      const seed = (seededKeyword && seededKeyword.trim())
        ? seededKeyword.trim()
        : seedOptions[Math.floor(Math.random() * seedOptions.length)];
      params.set("keyword", seed);
    }
    if (hasUserCity) params.set("city", city.trim());
    if (Number.isFinite(page) && page >= 0) params.set("page", String(page));
    // Always show upcoming events. Respect user-provided start date if set.
    if (startDate) {
      params.set("startDateTime", toTicketmasterIso(new Date(startDate)));
    } else {
      params.set("startDateTime", toTicketmasterIso(new Date()));
    }

    if (endDate) {
      const e = new Date(endDate);
      e.setHours(23, 59, 59, 999);
      params.set("endDateTime", toTicketmasterIso(e));
    }
const url = `https://app.ticketmaster.com/discovery/v2/events.json?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Ticketmaster API error ${res.status}${txt ? `: ${txt.slice(0,120)}` : ""}`);
    }
    const data = await res.json();

    const embedded = data?._embedded?.events || [];
    const events = embedded.map(ev => {
      const venue = ev?._embedded?.venues?.[0];
      const attractions = ev?._embedded?.attractions || [];
      const artists = attractions.map(a => a?.name).filter(Boolean);

      const dt = ev?.dates?.start?.dateTime
        || (ev?.dates?.start?.localDate ? `${ev.dates.start.localDate}T19:00:00` : null);

      const pr = (ev?.priceRanges && ev.priceRanges[0]) ? ev.priceRanges[0] : null;

      return {
        id: ev?.id || "",
        name: ev?.name || "Untitled event",
        type: (ev?.classifications?.[0]?.segment?.name || "event").toLowerCase(),
        dateTime: dt,
        city: venue?.city?.name || "",
        country: venue?.country?.countryCode || "",
        venue: venue?.name || "",
        outdoor: inferOutdoorFromVenueName(venue?.name || ""),
        artists,
        minPrice: pr?.min ?? null,
        maxPrice: pr?.max ?? null,
        rawUrl: ev?.url || "",
        imageUrl: pickBestImage(ev?.images)
      };
    });
    const pageInfo = {
      number: data?.page?.number ?? page,
      totalPages: data?.page?.totalPages ?? null
    };
    return { events, pageInfo };
  }

  // ---------- Explore page ----------
  const isExplore = location.pathname.endsWith("explore.html");
  if (isExplore) {
    const keyword = $("#keyword");
    const city = $("#city");
    const startDate = $("#startDate");
    const endDate = $("#endDate");
    const searchBtn = $("#searchBtn");
    const clearBtn = $("#clearBtn");
    const results = $("#results");
    const resultMeta = $("#resultMeta");
    const seedOptions = ["music","festival","comedy","sports","theatre","rock","pop"];
    let searchState = null;
    let isLoading = false;
    let hasMore = true;
    let totalLoaded = 0;
    let sentinel = null;

    function renderEvents(list, metaText, { append = false } = {}) {
      if (!append) {
        results.innerHTML = "";
        totalLoaded = 0;
      }
      resultMeta.textContent = metaText || `${totalLoaded} events`;

      if (!list.length) {
        if (!append) {
          results.innerHTML = `<div class="card" style="grid-column:1/-1;">
            <div class="cardTitle">No results</div>
            <div class="muted">Try a different keyword or city.</div>
          </div>`;
        } else {
          resultMeta.textContent = `Live results · ${totalLoaded} events`;
        }
        return;
      }

      for (const ev of list) {
        const chips = [
          ev.type ? `<span class="chip">${escapeHtml(ev.type)}</span>` : "",
          (ev.city || ev.country) ? `<span class="chip">${escapeHtml(ev.city)}${ev.country ? ", " + escapeHtml(ev.country) : ""}</span>` : ""].filter(Boolean).join("");

        const artists = (ev.artists && ev.artists.length) ? ev.artists.slice(0,3).join(" • ") : "";
        const price = (ev.minPrice != null && ev.maxPrice != null) ? `${money(ev.minPrice)}–${money(ev.maxPrice)}` : "—";

        const el = document.createElement("div");
        el.className = "eventCard";
        el.innerHTML = `
          <div class="eventMedia">${ev.imageUrl ? `<img src="${escapeHtml(ev.imageUrl)}" alt="${escapeHtml(ev.name)}">` : ``}</div>
          <div class="eventTitle">${escapeHtml(ev.name)}</div>
          <div class="eventMeta">${artists ? escapeHtml(artists) + " · " : ""}${escapeHtml(isoToNice(ev.dateTime || ""))}</div>
          <div class="eventMeta">${escapeHtml(ev.venue || "Venue")} · ${escapeHtml(ev.city || "")}</div>
          <div class="eventTags">${chips}</div>
          <div class="muted small">Click to open checkout</div>
        `;
        el.addEventListener("click", () => {
          setSelectedEvent(ev);
          window.location.href = "checkout.html";
        });
        results.appendChild(el);
      }
      totalLoaded += list.length;
      resultMeta.textContent = "Live Results";
    }

    function buildSearchState() {
      const q = (keyword.value || "").trim();
      const c = (city.value || "").trim();
      const sd = startDate.value || "";
      const ed = endDate.value || "";
      const hasUserKeyword = !!q;
      const hasUserCity = !!c;
      const hasUserDates = !!(sd || ed);
      const seededKeyword = (!hasUserKeyword && !hasUserCity && !hasUserDates)
        ? seedOptions[Math.floor(Math.random() * seedOptions.length)]
        : "";
      return { keyword: q, city: c, startDate: sd, endDate: ed, seededKeyword, page: 0 };
    }

    async function loadNextPage({ append } = { append: true }) {
      if (isLoading || !hasMore || !searchState) return;
      isLoading = true;
      resultMeta.textContent = append ? "Loading more…" : "Searching…";
      try {
        const { events, pageInfo } = await fetchTicketmasterEvents(searchState);
        renderEvents(events, null, { append });
        const currentPage = pageInfo?.number ?? searchState.page;
        if (pageInfo?.totalPages != null && currentPage >= pageInfo.totalPages - 1) {
          hasMore = false;
        }
        if (!events.length) {
          hasMore = false;
        }
        searchState.page = currentPage + 1;
      } catch (err) {
        console.error(err);
        if (!append) {
          renderEvents([], `Error: ${err?.message || err}`);
        } else {
          resultMeta.textContent = `Error: ${err?.message || err}`;
          hasMore = false;
        }
      } finally {
        isLoading = false;
      }
    }

    async function runSearch() {
      searchBtn.disabled = true;
      searchBtn.textContent = "Searching…";
      try {
        searchState = buildSearchState();
        hasMore = true;
        await loadNextPage({ append: false });
      } finally {
        searchBtn.disabled = false;
        searchBtn.textContent = "Search";
      }
    }

    searchBtn?.addEventListener("click", runSearch);
    clearBtn?.addEventListener("click", () => {
      keyword.value = "";
      city.value = "";
      startDate.value = "";
      endDate.value = "";
      runSearch();
    });

    function initInfiniteScroll() {
      if (!results || sentinel) return;
      sentinel = document.createElement("div");
      sentinel.id = "scrollSentinel";
      sentinel.style.height = "1px";
      results.insertAdjacentElement("afterend", sentinel);

      if ("IntersectionObserver" in window) {
        const io = new IntersectionObserver((entries) => {
          if (entries.some(e => e.isIntersecting)) loadNextPage({ append: true });
        }, { root: null, rootMargin: "200px" });
        io.observe(sentinel);
      } else {
        let ticking = false;
        window.addEventListener("scroll", () => {
          if (ticking) return;
          ticking = true;
          requestAnimationFrame(() => {
            ticking = false;
            const nearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 300;
            if (nearBottom) loadNextPage({ append: true });
          });
        });
      }
    }

    initInfiniteScroll();
    // initial
    runSearch();
  }

  
  // ---------- Checkout (live event + Rain Line) ----------
  const isCheckout = location.pathname.endsWith("checkout.html");
  if (isCheckout) {
    // Prevent direct navigation to checkout without selecting an event.
    // The demo is meant to flow: Explore → select event → Checkout.
    const selectedAtLoad = getSelectedEvent();
    if (!selectedAtLoad) {
      window.location.replace("explore.html");
      return;
    }
    // Pricing: derived from Ticketmaster priceRanges when available
    let baseTicket = 0; // per ticket
    let priceNote = "";

    const svcRate = 0.15; // mock platform fees (Ticket sites vary; keep stable for demo)
    const procFee = 6.0;

    let qty = 1;

let isOutdoor = true;

    // Rainline stake (base price)
    let stake = 10.00;           // what user pays to play (user may increase)
    const houseEdge = 0.18;      // makes odds slightly unfavorable

    // Weather projection state (inches, precipitation over event window)
    let projectedRainIn = null;  // inches
    let forecastAvailable = false;

    const elQty = $("#qty");
    const elTicketPrice = $("#ticketPrice");
    const elRainStakeRow = $("#rainStakeRow");
    const elRainStake = $("#rainStake");
    const elSvcFee = $("#svcFee");
    const elProcFee = $("#procFee");
    const elGrandTotal = $("#grandTotal");

    const panel = $("#rcPanel");
    const closePanel = $("#closePanel");
    const togglePanelBtn = $("#toggleExtensionBtn");

    // Panel elements (new)
    const forecastText = $("#forecastText");
    const rainLine = $("#rainLine");
    const rainLineValue = $("#rainLineValue");
    const winChance = $("#winChance");
    const stakeAmt = $("#stakeAmt");
    const stakeInput = $("#stakeInput");
    const payoutAmt = $("#payoutAmt");
    const coveragePct = $("#coveragePct");
    const placeBet = $("#placeBet");

    const betResult = $("#betResult");
    const betTitle = $("#betTitle");
    const betText = $("#betText");

    // Demo controls (still useful)
    const outdoorSelect = $("#isOutdoor");
    const eventType = $("#eventType");
    const resetDemo = $("#resetDemo");

    // Checkout display fields
    const eventName = $("#eventName");
    const eventMeta = $("#eventMeta");
    const eventVenue = $("#eventVenue");
    const eligTag = $("#eligTag");
    const eventImage = $("#eventImage");

    function setPanelVisible(visible) {
      panel.classList.toggle("hidden", !visible);
    }

    // Fetch full event by id to refresh images + price ranges + venue location
    async function fetchEventById(eventId) {
      const url = `https://app.ticketmaster.com/discovery/v2/events/${encodeURIComponent(eventId)}.json?apikey=${encodeURIComponent(TICKETMASTER_API_KEY)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Event details error ${res.status}`);
      return await res.json();
    }

    // Only allow ONE Rainline stake per order/event.
    // If a pending Rainline bet already exists for the selected event, we update it.
    function getPendingRainlineForSelectedEvent() {
      const sel = getSelectedEvent();
      const selId = sel?.id || null;
      const o = getStoredOrder();
      if (!o?.raincheck || o.raincheck.mode !== "rainline") return null;
      if ((o.raincheck.status || "pending") !== "pending") return null;
      // If both orders have a sourceEventId, they must match.
      const oId = o?.event?.sourceEventId || null;
      if (selId && oId && selId !== oId) return null;
      return o;
    }

    function computeFees() {
      const ticketSubtotal = baseTicket > 0 ? baseTicket * qty : 0;
      const svcFee = ticketSubtotal * svcRate;
      const ticketWithFees = ticketSubtotal + svcFee + procFee;

      // Add a single Rainline stake to the checkout total (if saved).
      const pending = getPendingRainlineForSelectedEvent();
      const rainStake = Number(pending?.raincheck?.stake || 0);

      const grand = ticketWithFees + (rainStake > 0 ? rainStake : 0);
      return { ticketSubtotal, svcFee, procFee, ticketWithFees, rainStake, grand };
    }

    function renderTotals() {
      const { svcFee, ticketWithFees, rainStake, grand } = computeFees();

      elQty.textContent = String(qty);

      if (baseTicket > 0) {
        elTicketPrice.textContent = money(baseTicket * qty);
        elSvcFee.textContent = money(svcFee);
      } else {
        elTicketPrice.textContent = "—";
        elSvcFee.textContent = "—";
      }

      elProcFee.textContent = money(procFee);

      // Rainline stake line item (always visible in its own section)
      if (elRainStakeRow && elRainStake) {
        elRainStakeRow.style.display = "flex";
        elRainStake.textContent = money(rainStake > 0 ? rainStake : 0);
      }

      elGrandTotal.textContent = baseTicket > 0 ? money(grand) : "—";
    }

    // Coverage schedule based on selected line (higher line -> higher coverage)
    function coverageForLine(lineIn) {
      if (lineIn <= 0.05) return 0.20;
      if (lineIn <= 0.15) return 0.35;
      if (lineIn <= 0.30) return 0.60;
      if (lineIn <= 0.50) return 1.00;
      if (lineIn <= 0.75) return 1.15;
      return 1.25;
    }

    function normalCdf(z) {
      // Abramowitz-Stegun approximation
      const t = 1 / (1 + 0.2316419 * Math.abs(z));
      const d = 0.3989423 * Math.exp(-z * z / 2);
      let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
      if (z > 0) p = 1 - p;
      return p;
    }

    function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

    // Probability rain >= line, using a simple uncertainty model around the projected amount.
    function winProbability(lineIn) {
      if (projectedRainIn == null) return null;

      // Uncertainty grows with amount; ensure a minimum.
      const mu = projectedRainIn;
      const sigma = Math.max(0.08, mu * 0.65); // inches

      // P(X >= line) = 1 - CDF((line-mu)/sigma)
      const z = (lineIn - mu) / sigma;
      const p = 1 - normalCdf(z);

      // Apply house edge by "worsening" the odds slightly (lower displayed win chance)
      return clamp(p * (1 - houseEdge), 0.01, 0.99);
    }

    // If we don't have a forecast (e.g., event too far out), we still need a
    // usable demo probability so odds + stake scaling work.
    function fallbackWinProbability(lineIn) {
      // Higher rain line => lower chance. Keep within a reasonable demo range.
      const base = clamp(0.65 - (lineIn * 0.55), 0.10, 0.70);
      return clamp(base * (1 - houseEdge), 0.05, 0.90);
    }

    function effectiveWinProbability(lineIn) {
      const p = winProbability(lineIn);
      return (p == null) ? fallbackWinProbability(lineIn) : p;
    }

    // Convert win probability into a payout multiplier. We return a single
    // "payout if win" value (not including stake back), capped elsewhere.
    // House keeps a small vig (~10%) so expected value stays slightly negative.
    function payoutMultiplierFromP(p) {
      // House-favored, risk-reward curve:
      // - High win chance (betting below/near the forecast) => low multiplier (small upside)
      // - Low win chance (riskier line) => multiplier grows superlinearly
      // Expected value stays negative due to vig + the houseEdge already applied to p.
      const vig = 0.22;           // bigger = more house edge
      const expo = 1.35;          // >1 makes payouts grow faster as p shrinks (more risk, more reward)
      const pClamped = clamp(p, 0.03, 0.97);
      return Math.pow(1 / pClamped, expo) * (1 - vig);
    }

    async function fetchPrecipProjection({ lat, lon, eventIso }) {
      // Use Open-Meteo (no key). Forecast is limited in horizon; if too far out, it may not include the date.
      // We'll request hourly precip and sum around event time.
      const dt = new Date(eventIso);
      if (Number.isNaN(dt.getTime())) throw new Error("Invalid event datetime");

      // Build a small window +/- 6 hours around event time (UTC). Open-Meteo can auto timezone; we keep UTC for consistency.
      const start = new Date(dt.getTime() - 6 * 3600_000);
      const end = new Date(dt.getTime() + 6 * 3600_000);

      const fmt = (d) => d.toISOString().slice(0, 10);
      const startDate = fmt(start);
      const endDate = fmt(end);

      const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&hourly=precipitation&timezone=UTC&start_date=${startDate}&end_date=${endDate}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Weather API error ${res.status}`);
      const data = await res.json();

      const times = data?.hourly?.time || [];
      const precip = data?.hourly?.precipitation || []; // mm
      if (!times.length || precip.length !== times.length) throw new Error("Weather data missing");

      // Sum precip in the 3-hour event window centered on event hour
      const center = dt.toISOString().slice(0, 13); // YYYY-MM-DDTHH
      let sumMm = 0;
      let count = 0;
      for (let i = 0; i < times.length; i++) {
        const t = times[i]; // ISO-ish in UTC
        if (!t) continue;
        // consider hours within [-1, +2] around center hour
        if (t.slice(0, 13) === center) { /* center */ }
        const hourDiff = (new Date(t).getTime() - dt.getTime()) / 3600_000;
        if (hourDiff >= -1 && hourDiff <= 2) {
          sumMm += Number(precip[i] || 0);
          count++;
        }
      }

      // If we couldn't match hours, fall back to sum all returned hours (still within window)
      if (count === 0) {
        sumMm = precip.reduce((a, v) => a + Number(v || 0), 0);
      }

      const inches = sumMm / 25.4;
      return { inches, sumMm, startDate, endDate };
    }

    async function applySelectedEventToCheckout() {
      const ev = getSelectedEvent();
      if (!ev) return;

      // Seed pricing from the search result so totals don't show "—" while we
      // wait for the details fetch (and so we have a fallback if details lack priceRanges).
      if (ev.minPrice != null) {
        baseTicket = Math.max(10, Math.round(Number(ev.minPrice)));
        if (ev.maxPrice != null) priceNote = `${money(Number(ev.minPrice))}–${money(Number(ev.maxPrice))} range`;
        else priceNote = `${money(Number(ev.minPrice))} from`;
      } else if (ev.maxPrice != null) {
        baseTicket = Math.max(10, Math.round(Number(ev.maxPrice)));
        priceNote = `${money(Number(ev.maxPrice))} from`;
      }

      // Render base UI quickly
      if (eventName) eventName.textContent = ev.name || "Event";
      if (eventMeta) eventMeta.textContent = `${isoToNice(ev.dateTime || "")} • ${ev.outdoor ? "Outdoor Venue" : "Indoor Venue"}`;
      if (eventVenue) eventVenue.textContent = `${ev.venue || "Venue"} • ${ev.city || ""}${ev.country ? ", " + ev.country : ""}`;

      isOutdoor = !!ev.outdoor;
      if (outdoorSelect) outdoorSelect.value = isOutdoor ? "true" : "false";

      if (eventType && ev.type) {
        const t = String(ev.type).toLowerCase();
        const normalized = (t.includes("sports")) ? "sports"
          : (t.includes("festival")) ? "festival"
          : (t.includes("theatre") || t.includes("theater")) ? "theatre"
          : "concert";
        eventType.value = normalized;
      }

      if (eligTag) {
        eligTag.classList.remove("bad");
        eligTag.classList.add("good");
        eligTag.textContent = "Rainline available";
      }

      // If we have an image already from search, show it
      if (eventImage) {
        if (ev.imageUrl) {
          eventImage.src = ev.imageUrl;
          eventImage.style.display = "block";
        } else {
          eventImage.removeAttribute("src");
          eventImage.style.display = "none";
        }
      }

      // Enrich with live event details (price range + better image + lat/lon)
      try {
        if (ev.id) {
          const full = await fetchEventById(ev.id);

          // Refresh image if better
          const img = pickBestImage(full?.images);
          if (eventImage && img) {
            eventImage.src = img;
            eventImage.style.display = "block";
          }

          // Price
          const pr = full?.priceRanges?.[0];
          if (pr && pr.min != null) {
            baseTicket = Math.max(10, Math.round(Number(pr.min)));
            priceNote = (pr.max != null) ? `${money(Number(pr.min))}–${money(Number(pr.max))} range` : `${money(Number(pr.min))} from`;
          } else {
            // Don't wipe out the seed price; keep the best known value.
            if (!baseTicket || baseTicket <= 0) {
              baseTicket = 0;
              priceNote = "Price unavailable from Ticketmaster Discovery API";
            }
          }

          // Weather forecast: need venue location
          const venue = full?._embedded?.venues?.[0];
          const lat = venue?.location?.latitude;
          const lon = venue?.location?.longitude;

          if (lat && lon && full?.dates?.start?.dateTime) {
            forecastText.textContent = "Fetching precipitation forecast…";
            try {
              const proj = await fetchPrecipProjection({ lat, lon, eventIso: full.dates.start.dateTime });
              projectedRainIn = proj.inches;
              forecastAvailable = true;
              forecastText.textContent =
                `Projected precip (event window): ~${projectedRainIn.toFixed(2)}" (${proj.sumMm.toFixed(1)} mm).`;
            } catch (e) {
              projectedRainIn = null;
              forecastAvailable = false;
              forecastText.textContent =
                "Forecast unavailable for this date/location (some APIs only forecast ~2 weeks ahead).";
            }
          } else {
            projectedRainIn = null;
            forecastAvailable = false;
            forecastText.textContent = "No venue coordinates available for forecast.";
          }
        }
      } catch (e) {
        // Keep UI usable even if enrichment fails
        projectedRainIn = null;
        forecastAvailable = false;
        forecastText.textContent = "Could not load event details/forecast.";
      }

      // Last-resort demo fallback: Ticketmaster's Discovery API often omits
      // priceRanges (or CORS can fail when opened as file://). Keep checkout
      // totals functional by estimating a per-ticket price.
      if (!baseTicket || baseTicket <= 0) {
        const t = (eventType?.value || ev?.type || "concert").toString().toLowerCase();
        const est = t.includes("sports") ? 120
          : t.includes("festival") ? 150
          : (t.includes("theatre") || t.includes("theater")) ? 80
          : 95;
        baseTicket = est;
        priceNote = "Estimated (demo) — Ticketmaster priceRanges unavailable";
      }

      renderTotals();
      updateRainLineUI();
    }

    let stakeInputTouched = false;

    function minStakeForTicket(ticketSubtotal) {
      const pct = ticketSubtotal > 0 ? (ticketSubtotal * 0.10) : 0;
      return Math.max(10, pct);
    }

    function readStakeInput(minStake) {
      if (!stakeInput) return { valid: false, empty: true, value: null, reason: "missing" };
      const raw = String(stakeInput.value ?? "").trim();
      if (!raw) return { valid: false, empty: true, value: null, reason: "empty" };
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return { valid: false, empty: false, value: null, reason: "invalid" };
      if (n < minStake) return { valid: false, empty: false, value: n, reason: "below_min" };
      return { valid: true, empty: false, value: n, reason: "ok" };
    }

    function updateRainLineUI() {
      const line = Number(rainLine.value || 0);
      rainLineValue.textContent = `${line.toFixed(2)}"`;

      const fees = computeFees();
      const ticketSubtotal = fees.ticketSubtotal; // ticket price * qty (before fees)

      // Win probability + odds-derived payout multiplier (stake-scaled)
      const pEff = effectiveWinProbability(line);
      winChance.textContent = `${Math.round(pEff * 100)}%`;

      const multRaw = payoutMultiplierFromP(pEff);
      // Keep the UI sane, but do NOT cap the user's stake.
      const mult = clamp(multRaw, 1.05, 25.0);

      // Minimum (and default) stake is 10% of the ticket subtotal (price * qty) or $10.
      const minStake = minStakeForTicket(ticketSubtotal);
      const stakeState = readStakeInput(minStake);
      const stakeIsValid = stakeState.valid || (!stakeInputTouched && stakeState.empty);

      // Initialize stake to the minimum once, but allow users to clear/edit the field.
      if (!Number.isFinite(stake) || stake <= 0) stake = minStake;
      stake = Math.max(minStake, stake);
      if (stakeState.valid) {
        stake = stakeState.value;
      }

      if (stakeInput) {
        if (!stakeInputTouched && stakeState.empty) {
          stakeInput.value = stake.toFixed(2);
        }
        // No max cap (effectively infinity)
        stakeInput.removeAttribute("max");
        stakeInput.min = minStake.toFixed(2);
        stakeInput.placeholder = minStake.toFixed(2);
        stakeInput.setAttribute("aria-invalid", stakeState.valid || stakeState.empty ? "false" : "true");
      }
      stakeAmt.textContent = money(stake);

      // Payout if win (stake-scaled). No cap.
      const payoutIfWin = (ticketSubtotal > 0 && line > 0) ? (stake * mult) : 0;
      payoutAmt.textContent = payoutIfWin > 0 ? money(payoutIfWin) : "—";

      // Show "coverage" as percent of ticket subtotal this payout would cover.
      const pct = (ticketSubtotal > 0 && payoutIfWin > 0) ? (payoutIfWin / ticketSubtotal) : 0;
      coveragePct.textContent = (ticketSubtotal > 0) ? `${Math.round(pct * 100)}%` : "—";

      // Rainline is always available, but line must be > 0.00" and we need a valid ticket price.
      const canBet = (ticketSubtotal > 0) && (line > 0) && (stakeIsValid);
      placeBet.disabled = !canBet;
      placeBet.textContent = canBet ? "Save Rainline bet" : "Unavailable";

      // If forecast missing, still allow betting but show a warning in text
      if (!forecastAvailable) {
        forecastText.textContent = forecastText.textContent || "Forecast unavailable for this date/location.";
      }

      // UX hint: show the computed minimum in the stake input tooltip
      if (stakeInput && ticketSubtotal >= 0) {
        stakeInput.title = `Minimum stake is 10% of your ticket total or $10, whichever is greater: ${money(minStake)}.`;
      }
    }

    // Note: we intentionally do not settle at checkout. Settlement happens after the event.

    // Quantity buttons
    $$(".qty .iconBtn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const a = btn.getAttribute("data-action");
        if (a === "inc") qty = Math.min(8, qty + 1);
        if (a === "dec") qty = Math.max(1, qty - 1);
        renderTotals();
        updateRainLineUI();
      });
    });

    // Panel controls
    closePanel?.addEventListener("click", () => setPanelVisible(false));
    togglePanelBtn?.addEventListener("click", () =>
      setPanelVisible(panel.classList.contains("hidden"))
    );

    // Demo controls
    outdoorSelect?.addEventListener("change", (e) => {
      isOutdoor = e.target.value === "true";
      // Rainline stays available either way; just update dependent display.
      updateRainLineUI();
    });

    eventType?.addEventListener("change", () => updateRainLineUI());

    resetDemo?.addEventListener("click", () => {
      qty = 1;
      isOutdoor = true;
      outdoorSelect.value = "true";
      eventType.value = "concert";
      rainLine.value = "0.25";
      betResult.style.display = "none";
      updateRainLineUI();
      setPanelVisible(true);
    });

    rainLine?.addEventListener("input", () => updateRainLineUI());

    stakeInput?.addEventListener("input", () => {
      stakeInputTouched = true;
      // updateRainLineUI() will enforce the dynamic minimum stake (10% of ticket total)
      stake = Number(stakeInput.value) || stake;
      updateRainLineUI();
    });

// Save Rainline bet (no projected win/loss at checkout)
    placeBet?.addEventListener("click", () => {
      const line = Number(rainLine.value || 0);
      const { ticketWithFees, ticketSubtotal } = computeFees();

      const ticketTotal = ticketSubtotal; // before fees; stake minimum is based on this
      const pEff = effectiveWinProbability(line);
      const mult = clamp(payoutMultiplierFromP(pEff), 1.05, 25.0);

      const minStake = minStakeForTicket(ticketTotal);
      const stakeState = readStakeInput(minStake);
      if (!stakeState.valid) {
        betResult.style.display = "block";
        betResult.classList.remove("good", "neutral");
        betResult.classList.add("bad");
        betTitle.textContent = "Invalid stake";
        if (stakeState.reason === "below_min") {
          betText.textContent = `Stake must be at least ${money(minStake)}.`;
        } else {
          betText.textContent = "Enter a valid, positive stake amount.";
        }
        return;
      }
      stake = stakeState.value;

      if (line <= 0) {
        betResult.style.display = "block";
        betResult.classList.remove("good", "neutral");
        betResult.classList.add("bad");
        betTitle.textContent = "Invalid Rainline";
        betText.textContent = "Rain line must be greater than 0.00\".";
        return;
      }

      if (!(ticketTotal > 0)) {
        betResult.style.display = "block";
        betResult.classList.remove("good", "neutral");
        betResult.classList.add("bad");
        betTitle.textContent = "Ticket price missing";
        betText.textContent = "We couldn’t fetch ticket pricing for this event, so Rainline is disabled.";
        return;
      }

      // Payout if win (not capped)
      const payoutIfWin = stake * mult;

      // Store a single order-like object for claim demo.
      // If a pending Rainline already exists for this event, update it
      // (prevents multiple stakes being added).
      const ev = getSelectedEvent();
      const existing = getPendingRainlineForSelectedEvent();
      const order = existing || {
        id: "TH-" + Math.random().toString(16).slice(2, 10).toUpperCase(),
        createdAt: new Date().toISOString(),
      };

      order.event = {
        name: ev?.name || eventName?.textContent || "Event",
        datetime: ev?.dateTime ? isoToNice(ev.dateTime) : (eventMeta?.textContent || "Unknown time"),
        outdoor: isOutdoor,
        type: eventType?.value || "concert",
        venue: ev?.venue || (eventVenue?.textContent || ""),
        city: ev?.city || "",
        country: ev?.country || "",
        sourceEventId: ev?.id || null,
      };

      order.qty = qty;
      order.pricing = {
        ticketSubtotal,
        serviceFee: svcFee,
        processingFee: procFee,
        // Total shown at checkout includes the Rainline stake.
        total: ticketWithFees + stake,
        baseTicket,
        note: priceNote
      };

      order.raincheck = {
        mode: "rainline",
        stake,
        lineIn: line,
        status: "pending",
        payoutIfWin,
        ticketTotal
      };
      order.updatedAt = new Date().toISOString();
      setStoredOrder(order);
      betResult.style.display = "block";

      betResult.classList.remove("good", "bad");
      betResult.classList.add("neutral");
      betTitle.textContent = "Saved ✓";
      betText.textContent = `Your Rainline is saved (pending settlement after the event). Line: ${line.toFixed(2)}" • Stake: ${money(stake)}.`;

      // Reflect the saved stake in the checkout totals.
      renderTotals();
    });

    // Keep Pay now button behavior (just saves order without rainline)
    const payBtn = $("#payBtn");
    payBtn?.addEventListener("click", () => {
      const f = computeFees();
      const ev = getSelectedEvent();

      // If the user already saved a Rainline bet for this event, don't allow
      // creating a second one. Just persist the existing order with updated pricing.
      const existing = getPendingRainlineForSelectedEvent();
      const order = existing || {
        id: "TH-" + Math.random().toString(16).slice(2, 10).toUpperCase(),
        createdAt: new Date().toISOString(),
      };

      order.event = {
        name: ev?.name || eventName?.textContent || "Event",
        datetime: ev?.dateTime ? isoToNice(ev.dateTime) : (eventMeta?.textContent || "Unknown time"),
        outdoor: isOutdoor,
        type: eventType?.value || "concert",
        venue: ev?.venue || (eventVenue?.textContent || ""),
        city: ev?.city || "",
        country: ev?.country || "",
        sourceEventId: ev?.id || null,
      };

      order.qty = qty;
      order.pricing = {
        ticketSubtotal: f.ticketSubtotal,
        serviceFee: f.svcFee,
        processingFee: f.procFee,
        // Grand total shown in checkout (includes stake if present)
        total: f.grand,
        baseTicket,
        note: priceNote
      };

      order.updatedAt = new Date().toISOString();
      setStoredOrder(order);
      payBtn.textContent = "Saved ✓ (for claim demo)";
      setTimeout(() => (payBtn.textContent = "Pay now"), 1100);
    });

    // init
    applySelectedEventToCheckout();
    renderTotals();
    updateRainLineUI();
    setPanelVisible(true);
  }

  // ---------- Claim demo (Rainline settlement) ----------
  const isClaim = location.pathname.endsWith("claim.html");
  if (isClaim) {
    const orderBox = $("#orderBox");
    const loadPurchase = $("#loadPurchase");
    const submitClaim = $("#submitClaim");

    const demoWon = $("#demoWon");
    const demoLost = $("#demoLost");

    const decision = $("#decision");
    const decisionTitle = decision?.querySelector(".decisionTitle");
    const decisionText = decision?.querySelector(".decisionText");

    const payoutAmt = $("#refundAmt");
    const payoutStatus = $("#refundStatus");

    let order = null;

    function setDecision(state, title, text) {
      decision.classList.remove("neutral", "good", "bad");
      decision.classList.add(state);
      decisionTitle.textContent = title;
      decisionText.textContent = text;
    }

    function renderOrder() {
      if (!order) {
        orderBox.textContent = "No order loaded yet.";
        return;
      }

      const lines = [
        `Order: ${order.id}`,
        `Event: ${order.event?.name || "—"}`,
        `When: ${order.event?.datetime || "—"}`,
        `Venue: ${order.event?.venue || "—"}`,
        `Outdoor: ${order.event?.outdoor ? "Yes" : "No"}`,
        `Tickets: ${order.qty || 1}`,
        `Total paid: ${money(order.pricing?.total || 0)}`];

      if (order.raincheck?.mode === "rainline") {
        lines.push("—");
        lines.push("Rainline bet:");
        lines.push(`  Line: ${Number(order.raincheck.lineIn || 0).toFixed(2)}\"`);
        lines.push(`  Stake: ${money(Number(order.raincheck.stake || 0))}`);
        lines.push(`  Status: ${order.raincheck.status || "pending"}`);
      } else {
        lines.push("—");
        lines.push("No Rainline bet found on this order.");
      }

      orderBox.textContent = lines.join("\n");
    }

    function load() {
      order = getStoredOrder();
      renderOrder();
      payoutAmt.textContent = money(0);
      payoutStatus.textContent = order ? "Loaded" : "—";

      if (!order) {
        setDecision("bad", "No order found", "Go to Checkout, save a Rainline bet, then come back here.");
        return;
      }

      if (order.raincheck?.mode !== "rainline") {
        setDecision("bad", "No Rainline bet", "Your last saved order didn’t include a Rainline bet.");
        return;
      }

      setDecision("neutral", "Ready", "Choose a demo outcome and click Settle.");
    }

    loadPurchase?.addEventListener("click", load);

    submitClaim?.addEventListener("click", () => {
      if (!order) {
        setDecision("bad", "Missing order", "Load a purchase first.");
        payoutAmt.textContent = money(0);
        payoutStatus.textContent = "Denied";
        return;
      }

      if (order.raincheck?.mode !== "rainline") {
        setDecision("bad", "No Rainline bet", "This order doesn’t have a Rainline bet to settle.");
        payoutAmt.textContent = money(0);
        payoutStatus.textContent = "Denied";
        return;
      }

      const won = !!demoWon?.checked && !demoLost?.checked;
      const line = Number(order.raincheck.lineIn || 0);
      const total = Number(order.pricing?.total || 0);
      const payoutIfWin = Number(order.raincheck.payoutIfWin || (total * coverageForLine(line)));

      if (won) {
        order.raincheck.status = "won";
        order.raincheck.settledAt = new Date().toISOString();
        order.raincheck.payout = payoutIfWin;
        setStoredOrder(order);

        setDecision("good", "Won ✓", `Your Rainline hit. Payout: ${money(payoutIfWin)}.`);
        payoutAmt.textContent = money(payoutIfWin);
        payoutStatus.textContent = "Paid (demo)";
      } else {
        order.raincheck.status = "lost";
        order.raincheck.settledAt = new Date().toISOString();
        order.raincheck.payout = 0;
        setStoredOrder(order);

        setDecision("bad", "Lost", `Your Rainline missed. You lose the stake (${money(Number(order.raincheck.stake || 0))}).`);
        payoutAmt.textContent = money(0);
        payoutStatus.textContent = "No payout";
      }

      renderOrder();
    });

    // Auto-load on page open
    load();
  }
})();

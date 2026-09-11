// ── SHARED SITE NAV ──
// Drop <div id="siteNav"></div> anywhere in your <body> (ideally before <main>)
// and load this file with <script type="module" src="nav.js"></script>.
// Navigation renders independently of Firebase so a blocked/slow auth service
// can never prevent the menu, mobile controls or Join link from working.

const SITE_BUILD = "20260911-2";

function buildSiteNav() {
  const navMount = document.getElementById("siteNav");
  if (!navMount) return null;

  navMount.innerHTML = `
    <header class="site-topbar">
      <a href="index.html" class="site-topbar-logo-wrap" aria-label="Go to homepage">
        <img src="images/logo1.png" alt="Our Wedding Day Hub" class="site-topbar-logo">
      </a>
      <div class="site-topbar-title">
        <h1>Our Wedding Day Hub</h1>
      </div>
      <nav class="site-topbar-actions">
        <div class="nav-links">
          <a href="categories.html" class="site-topbar-link">Categories</a>
          <a href="shop.html" class="site-topbar-link">Boutique</a>
          <a href="journal.html" class="site-topbar-link">The Journal</a>
          <a href="messages.html" id="messagesLink" class="site-topbar-link" style="display:none; position:relative;">
            Messages
            <span id="msgNavBadge" style="display:none; position:absolute; top:-6px; right:-10px; background:var(--ink); color:var(--cream); font-size:0.64rem; font-weight:700; padding:2px 6px; border-radius:999px; line-height:1.2; min-width:18px; text-align:center;">0</span>
          </a>
          <a href="dashboard.html" id="dashboardLink" class="site-topbar-link" style="display:none;">Dashboard</a>
          <button id="logoutLink" class="site-topbar-btn" style="display:none;">Log Out</button>
        </div>
        <a href="login.html" id="loginLink" class="site-topbar-link">Log In</a>
        <a href="signup.html?v=${SITE_BUILD}" id="joinLink" class="site-topbar-btn">Join</a>
        <button class="mobile-menu-btn" type="button" aria-label="Open menu">☰</button>
      </nav>
    </header>
  `;

  const menuBtn = navMount.querySelector(".mobile-menu-btn");
  const navLinks = navMount.querySelector(".nav-links");

  if (menuBtn && navLinks) {
    menuBtn.addEventListener("click", () => navLinks.classList.toggle("active"));
    navLinks.addEventListener("click", (e) => {
      if (e.target.tagName === "A" || e.target.tagName === "BUTTON") {
        navLinks.classList.remove("active");
      }
    });
    document.addEventListener("click", (e) => {
      if (!navMount.contains(e.target)) navLinks.classList.remove("active");
    });
  }

  return navMount;
}

async function wireAuthState(navMount) {
  if (!navMount) return;

  const loginLink = navMount.querySelector("#loginLink");
  const joinLink = navMount.querySelector("#joinLink");
  const dashboardLink = navMount.querySelector("#dashboardLink");
  const logoutLink = navMount.querySelector("#logoutLink");
  const messagesLink = navMount.querySelector("#messagesLink");
  const msgNavBadge = navMount.querySelector("#msgNavBadge");

  // The logged-out state is the safe default. If Firebase is blocked by a
  // browser privacy feature, extension or network filter, navigation still works.
  loginLink && (loginLink.style.display = "inline-flex");
  joinLink && (joinLink.style.display = "inline-flex");
  dashboardLink && (dashboardLink.style.display = "none");
  logoutLink && (logoutLink.style.display = "none");
  messagesLink && (messagesLink.style.display = "none");

  try {
    const {
      auth,
      onAuthStateChanged,
      signOut,
      db,
      collection,
      query,
      where,
      getDocs
    } = await import(`./firebase.js?v=${SITE_BUILD}`);

    onAuthStateChanged(auth, async (user) => {
      if (user) {
        loginLink && (loginLink.style.display = "none");
        joinLink && (joinLink.style.display = "none");
        dashboardLink && (dashboardLink.style.display = "inline-flex");
        logoutLink && (logoutLink.style.display = "inline-flex");
        messagesLink && (messagesLink.style.display = "inline-flex");

        try {
          if (db && msgNavBadge) {
            const msgQuery = query(
              collection(db, "conversations"),
              where("coupleId", "==", user.uid)
            );
            const msgSnap = await getDocs(msgQuery);
            let unread = 0;
            msgSnap.forEach(d => { unread += (d.data().coupleUnread || 0); });

            const vendorQuery = query(
              collection(db, "conversations"),
              where("vendorId", "==", user.uid)
            );
            const vendorSnap = await getDocs(vendorQuery);
            vendorSnap.forEach(d => { unread += (d.data().vendorUnread || 0); });

            if (unread > 0) {
              msgNavBadge.textContent = unread > 99 ? "99+" : unread;
              msgNavBadge.style.display = "inline-block";
            } else {
              msgNavBadge.style.display = "none";
            }
          }
        } catch (_) {
          // Unread badge is non-critical.
        }

        if (logoutLink && !logoutLink.dataset.authBound) {
          logoutLink.dataset.authBound = "1";
          logoutLink.addEventListener("click", async () => {
            await signOut(auth);
            window.location.href = "index.html";
          });
        }
      } else {
        loginLink && (loginLink.style.display = "inline-flex");
        joinLink && (joinLink.style.display = "inline-flex");
        dashboardLink && (dashboardLink.style.display = "none");
        logoutLink && (logoutLink.style.display = "none");
        messagesLink && (messagesLink.style.display = "none");
      }
    });
  } catch (error) {
    // Keep the functional logged-out navigation rather than failing the page.
    console.warn("OWDH navigation auth unavailable; continuing without auth state.", error);
  }
}

const navMount = buildSiteNav();
wireAuthState(navMount);

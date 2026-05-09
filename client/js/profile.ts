// client/js/profile.js
// Full profile modal: avatar, bio, website, pronouns, banner, mutual servers, online status

(function () {

  window.openProfileModal = async function (userId) {
    document.getElementById('profile-modal')?.remove();

    const modal = document.createElement('div');
    modal.id        = 'profile-modal';
    modal.className = 'modal-overlay';
    modal.style.cssText = 'display:flex;z-index:1100;';
    modal.innerHTML = `
      <div class="profile-card" id="profile-card">
        <div class="profile-banner" id="profile-banner"></div>
        <button class="profile-close" onclick="document.getElementById('profile-modal').remove()">âœ•</button>
        <div class="profile-body">
          <div class="profile-avatar-wrap">
            <div class="profile-avatar" id="profile-avatar"></div>
            <div class="profile-status-dot" id="profile-status-dot"></div>
          </div>
          <div class="profile-info">
            <div class="profile-displayname" id="profile-displayname">â€¦</div>
            <div class="profile-username"   id="profile-username"></div>
            <div class="profile-pronouns"   id="profile-pronouns"></div>
          </div>
        </div>
        <div class="profile-sections">
          <div class="profile-section" id="profile-bio-section" style="display:none">
            <div class="profile-section-label">HAKKINDA</div>
            <div class="profile-section-value" id="profile-bio"></div>
          </div>
          <div class="profile-section" id="profile-website-section" style="display:none">
            <div class="profile-section-label">WEBSÄ°TE</div>
            <div class="profile-section-value" id="profile-website"></div>
          </div>
          <div class="profile-section" id="profile-mutual-section" style="display:none">
            <div class="profile-section-label">ORTAK SUNUCULAR</div>
            <div class="profile-section-value" id="profile-mutual"></div>
          </div>
          <div class="profile-actions" id="profile-actions"></div>
        </div>
        <div class="profile-loading" id="profile-loading">YÃ¼kleniyor...</div>
      </div>`;

    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

    await loadProfile(userId);
  };

  async function loadProfile(userId) {
    const loading = document.getElementById('profile-loading');
    try {
      // Fetch user data
      const r = await apiFetch(`${API}/api/users/${userId}`);
      if (!r.ok) throw new Error('KullanÄ±cÄ± bulunamadÄ±');
      const user = await r.json();

      loading?.remove();

      // Banner
      const banner = document.getElementById('profile-banner');
      if (user.bannerUrl) {
        banner.style.backgroundImage = `url('${API}${user.bannerUrl}')`;
        banner.style.backgroundSize  = 'cover';
        banner.style.backgroundPosition = 'center';
      } else if (user.bannerColor) {
        banner.style.background = cssColor(user.bannerColor);
      } else if (user.avatarColor) {
        banner.style.background = `linear-gradient(135deg, ${cssColor(user.avatarColor)}88, ${cssColor(user.avatarColor)}22)`;
      }

      // Avatar
      const avatar = document.getElementById('profile-avatar');
      if (user.avatarUrl) {
        const img = document.createElement('img');
        img.src = API + user.avatarUrl;
        img.alt = user.displayName;
        avatar.appendChild(img);
      } else {
        avatar.style.background = cssColor(user.avatarColor);
        avatar.textContent = initials(user.displayName);
      }

      // Status dot
      const dot = document.getElementById('profile-status-dot');
      dot.className = `profile-status-dot status-${user.status || 'offline'}`;
      dot.title = { online: 'Ã‡evrimiÃ§i', idle: 'Uzakta', dnd: 'RahatsÄ±z Etme', offline: 'Ã‡evrimdÄ±ÅŸÄ±' }[user.status] || 'Bilinmiyor';

      // Info
      document.getElementById('profile-displayname').textContent = user.displayName;
      document.getElementById('profile-username').textContent    = '@' + user.username;

      if (user.pronouns) {
        document.getElementById('profile-pronouns').textContent = user.pronouns;
      }

      // Custom status text
      if (user.statusText || user.statusEmoji) {
        const card = document.getElementById('profile-card');
        const statusLine = document.createElement('div');
        statusLine.className = 'profile-custom-status';
        statusLine.textContent = `${user.statusEmoji || ''} ${user.statusText || ''}`.trim();
        document.getElementById('profile-body')?.after(statusLine);
      }

      // Bio
      if (user.bio) {
        document.getElementById('profile-bio-section').style.display = '';
        document.getElementById('profile-bio').textContent = user.bio;
      }

      // Website
      if (user.website) {
        document.getElementById('profile-website-section').style.display = '';
        const link = document.createElement('a');
        link.href = user.website.startsWith('http') ? user.website : 'https://' + user.website;
        link.textContent = user.website.replace(/^https?:\/\//, '');
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'profile-link';
        document.getElementById('profile-website').appendChild(link);
      }

      // Actions (DM, friend request â€” only for other users)
      const actions = document.getElementById('profile-actions');
      if (userId !== window.me?.id) {
        const dmBtn = document.createElement('button');
        dmBtn.className = 'btn btn-primary';
        dmBtn.textContent = 'ğŸ’¬ Mesaj GÃ¶nder';
        dmBtn.onclick = () => {
          document.getElementById('profile-modal')?.remove();
          if (typeof openDm === 'function') openDm(userId, user.displayName, user.avatarColor);
        };
        actions.appendChild(dmBtn);

        const addBtn = document.createElement('button');
        addBtn.className = 'btn';
        addBtn.textContent = 'ğŸ‘¤+ ArkadaÅŸ Ekle';
        addBtn.onclick = async () => {
          const r2 = await apiFetch(`${API}/api/friends/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user.username }),
          });
          const d = await r2.json();
          toast(r2.ok ? 'âœ… ArkadaÅŸlÄ±k isteÄŸi gÃ¶nderildi' : (d.error || 'Hata'), r2.ok ? 'success' : 'error');
          addBtn.disabled = true;
          addBtn.textContent = 'âœ… Ä°stek GÃ¶nderildi';
        };
        actions.appendChild(addBtn);
      } else {
        // Own profile â€” edit button
        const editBtn = document.createElement('button');
        editBtn.className = 'btn btn-primary';
        editBtn.textContent = 'âœï¸ Profili DÃ¼zenle';
        editBtn.onclick = () => {
          document.getElementById('profile-modal')?.remove();
          if (typeof openSettingsModal === 'function') openSettingsModal();
        };
        actions.appendChild(editBtn);
      }

      // Mutual servers
      await loadMutualServers(userId);

    } catch (e) {
      if (loading) loading.textContent = e.message || 'Profil yÃ¼klenemedi';
    }
  }

  async function loadMutualServers(userId) {
    if (!window.currentServer) return;
    try {
      const r = await apiFetch(`${API}/api/users/${userId}/mutual-servers`);
      if (!r.ok) return;
      const servers = await r.json();
      if (!servers.length) return;

      const section = document.getElementById('profile-mutual-section');
      const val     = document.getElementById('profile-mutual');
      section.style.display = '';
      val.innerHTML = '';

      servers.slice(0, 5).forEach(s => {
        const chip = document.createElement('div');
        chip.className = 'mutual-server-chip';
        chip.innerHTML = `<span class="mutual-icon">${escHtml(s.icon || 'ğŸŒ')}</span><span>${escHtml(s.name)}</span>`;
        val.appendChild(chip);
      });
      if (servers.length > 5) {
        const more = document.createElement('span');
        more.className = 'mutual-more';
        more.textContent = `+${servers.length - 5} daha`;
        val.appendChild(more);
      }
    } catch { /* non-fatal */ }
  }

})();


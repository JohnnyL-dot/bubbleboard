// Lokal lagring i webbläsaren (KR-21, OQ-47). Arbetet ska överleva omladdning.
// Lagringen kan vara avstängd eller full (privat läge, nekad lagring), och då
// ska användaren varnas (KR-21). Allt som läses är opålitlig indata.

export const STORAGE_KEY = 'bubbleboard.session.v1';

/**
 * @param {Storage|undefined|null} backend t.ex. window.localStorage (kan kasta vid åtkomst)
 */
export function createStore(getBackend) {
  const backend = () => {
    try {
      return getBackend();
    } catch {
      return null;
    }
  };

  return {
    /** Går det att skriva och läsa? Provas på riktigt, eftersom åtkomsten kan kasta. */
    available() {
      const b = backend();
      if (!b) return false;
      try {
        const probe = `${STORAGE_KEY}.probe`;
        b.setItem(probe, '1');
        const ok = b.getItem(probe) === '1';
        b.removeItem(probe);
        return ok;
      } catch {
        return false;
      }
    },
    /** @returns {object|null} tolkad data, eller null om inget finns. Kastar vid trasig data. */
    load() {
      const b = backend();
      if (!b) return null;
      let text;
      try {
        text = b.getItem(STORAGE_KEY);
      } catch {
        return null;
      }
      if (text == null) return null;
      return JSON.parse(text);
    },
    /** @returns {boolean} false om det inte gick att spara (full eller nekad lagring) */
    save(snapshot) {
      const b = backend();
      if (!b) return false;
      try {
        b.setItem(STORAGE_KEY, JSON.stringify(snapshot));
        return true;
      } catch {
        return false;
      }
    },
    clear() {
      try {
        backend()?.removeItem(STORAGE_KEY);
      } catch {
        /* inget att göra */
      }
    },
  };
}

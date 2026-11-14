import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api.js';

const SessionCtx = createContext(null);

export function SessionProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = loading
  const [config, setConfig] = useState({});

  const refresh = useCallback(async () => {
    try {
      const { user } = await api('/auth/me');
      setUser(user);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    refresh();
    api('/config').then(setConfig).catch(() => {});
  }, [refresh]);

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    setUser(null);
  };

  return <SessionCtx.Provider value={{ user, setUser, refresh, logout, config }}>{children}</SessionCtx.Provider>;
}

export const useSession = () => useContext(SessionCtx);

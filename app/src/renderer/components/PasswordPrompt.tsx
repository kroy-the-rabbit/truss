import React, { useState } from 'react';
import { fetchSetupAPI } from '../api/client';

interface Props {
  onUnlocked: () => void;
}

export function PasswordPrompt({ onUnlocked }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setLoading(true);
    setError('');
    try {
      const resp = await fetchSetupAPI('/api/setup/unlock', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      if (resp.ok) {
        onUnlocked();
      } else {
        const data = await resp.json();
        setError(data.error || 'Unlock failed');
      }
    } catch (err) {
      setError(`Error: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="setup-screen">
      <div className="setup-card">
        <h1 className="setup-title">Truss</h1>
        <p className="setup-subtitle">Enter your master password to unlock the context store.</p>
        <form onSubmit={handleUnlock} className="setup-form">
          <label className="setup-label">
            Password
            <input
              type="password"
              className="setup-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              placeholder="Master password"
              aria-invalid={!!error}
              aria-describedby={error ? 'unlock-error' : undefined}
            />
          </label>
          {error && <div id="unlock-error" className="setup-error" role="alert">{error}</div>}
          <button type="submit" className="setup-btn-primary" disabled={loading || !password}>
            {loading ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>
      </div>
    </div>
  );
}

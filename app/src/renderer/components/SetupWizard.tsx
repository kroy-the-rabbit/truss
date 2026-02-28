import React, { useState, useEffect } from 'react';
import { fetchSetupAPI } from '../api/client';

interface Props {
  onComplete: () => void;
}

type Step = 'method' | 'configure' | 'import';
type Method = 'gpg' | 'password';

interface GPGKey {
  id: string;
  email: string;
  name: string;
}

interface SystemContext {
  name: string;
  cluster: string;
  user: string;
}

export function SetupWizard({ onComplete }: Props) {
  const [step, setStep] = useState<Step>('method');
  const [method, setMethod] = useState<Method>('password');
  const [gpgKeys, setGpgKeys] = useState<GPGKey[]>([]);
  const [selectedGpgKey, setSelectedGpgKey] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [configError, setConfigError] = useState('');
  const [configuring, setConfiguring] = useState(false);

  // Import step state
  const [systemContexts, setSystemContexts] = useState<SystemContext[]>([]);
  const [importMode, setImportMode] = useState<'system' | 'paste'>('system');
  const [pasteYaml, setPasteYaml] = useState('');
  const [importName, setImportName] = useState('');
  const [importDisplayName, setImportDisplayName] = useState('');
  const [selectedSystemCtx, setSelectedSystemCtx] = useState('');
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);
  const [importedNames, setImportedNames] = useState<string[]>([]);

  useEffect(() => {
    if (method === 'gpg') {
      fetchSetupAPI('/api/gpg-keys')
        .then((r) => r.json())
        .then((data) => {
          setGpgKeys(data.keys || []);
          if (data.keys?.length > 0) setSelectedGpgKey(data.keys[0].id);
        })
        .catch(() => setGpgKeys([]));
    }
  }, [method]);

  const loadSystemContexts = () => {
    fetchSetupAPI('/api/kubeconfig-contexts')
      .then((r) => r.json())
      .then((data) => setSystemContexts(data.contexts || []))
      .catch(() => setSystemContexts([]));
  };

  const handleConfigureSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setConfigError('');

    if (method === 'password') {
      if (password.length < 8) {
        setConfigError('Password must be at least 8 characters.');
        return;
      }
      if (password !== confirmPassword) {
        setConfigError('Passwords do not match.');
        return;
      }
    } else {
      if (!selectedGpgKey) {
        setConfigError('Select a GPG key.');
        return;
      }
    }

    setConfiguring(true);
    try {
      const resp = await fetchSetupAPI('/api/setup/initialize', {
        method: 'POST',
        body: JSON.stringify({
          method,
          gpg_key: method === 'gpg' ? selectedGpgKey : '',
          password: method === 'password' ? password : '',
        }),
      });
      if (resp.ok) {
        loadSystemContexts();
        setStep('import');
      } else {
        const data = await resp.json();
        setConfigError(data.error || 'Initialization failed');
      }
    } catch (err) {
      setConfigError(`Error: ${err}`);
    } finally {
      setConfiguring(false);
    }
  };

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setImportError('');
    if (!importName.trim()) {
      setImportError('A name is required.');
      return;
    }
    if (importMode === 'paste' && !pasteYaml.trim()) {
      setImportError('Paste your kubeconfig YAML.');
      return;
    }
    if (importMode === 'system' && !selectedSystemCtx) {
      setImportError('Select a context.');
      return;
    }

    setImporting(true);
    try {
      const body: Record<string, string> = {
        name: importName.trim(),
        display_name: importDisplayName.trim(),
      };
      if (importMode === 'system') {
        body.system_context = selectedSystemCtx;
      } else {
        body.kubeconfig = pasteYaml.trim();
      }

      const resp = await fetchSetupAPI('/api/contexts/import', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        setImportedNames((prev) => [...prev, importName.trim()]);
        setImportName('');
        setImportDisplayName('');
        setPasteYaml('');
        setSelectedSystemCtx('');
        setImportError('');
      } else {
        const data = await resp.json();
        setImportError(data.error || 'Import failed');
      }
    } catch (err) {
      setImportError(`Error: ${err}`);
    } finally {
      setImporting(false);
    }
  };

  if (step === 'method') {
    return (
      <div className="setup-screen">
        <div className="setup-card">
          <h1 className="setup-title">Welcome to Truss</h1>
          <p className="setup-subtitle">
            Your kubeconfig contexts will be stored in an encrypted vault.
            Choose your encryption method:
          </p>
          <div className="setup-method-options">
            <label className={`setup-method-option ${method === 'password' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="method"
                value="password"
                checked={method === 'password'}
                onChange={() => setMethod('password')}
              />
              <div className="setup-method-title">Password</div>
              <div className="setup-method-desc">
                Encrypt with AES-256-GCM using a master password derived with Argon2id.
                You will enter this password each time Truss starts.
              </div>
            </label>
            <label className={`setup-method-option ${method === 'gpg' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="method"
                value="gpg"
                checked={method === 'gpg'}
                onChange={() => setMethod('gpg')}
              />
              <div className="setup-method-title">GPG Key</div>
              <div className="setup-method-desc">
                Encrypt with a GPG key from your keyring. Decryption is automatic when your
                GPG agent has the key unlocked (e.g. via hardware token or agent).
              </div>
            </label>
          </div>
          <button
            className="setup-btn-primary"
            onClick={() => {
              if (method === 'gpg') {
                fetchSetupAPI('/api/gpg-keys')
                  .then((r) => r.json())
                  .then((data) => {
                    setGpgKeys(data.keys || []);
                    if (data.keys?.length > 0) setSelectedGpgKey(data.keys[0].id);
                  })
                  .catch(() => setGpgKeys([]));
              }
              setStep('configure');
            }}
          >
            Continue →
          </button>
        </div>
      </div>
    );
  }

  if (step === 'configure') {
    return (
      <div className="setup-screen">
        <div className="setup-card">
          <h1 className="setup-title">Configure Encryption</h1>
          <form onSubmit={handleConfigureSubmit} className="setup-form">
            {method === 'password' ? (
              <>
                <label className="setup-label">
                  Master Password
                  <input
                    type="password"
                    className="setup-input"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoFocus
                    placeholder="At least 8 characters"
                  />
                </label>
                <label className="setup-label">
                  Confirm Password
                  <input
                    type="password"
                    className="setup-input"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repeat password"
                  />
                </label>
              </>
            ) : (
              <label className="setup-label">
                GPG Key
                {gpgKeys.length === 0 ? (
                  <p className="setup-error" role="alert">No GPG secret keys found. Install GPG and import your key first.</p>
                ) : (
                  <select
                    className="setup-input"
                    value={selectedGpgKey}
                    onChange={(e) => setSelectedGpgKey(e.target.value)}
                  >
                    {gpgKeys.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.name} &lt;{k.email}&gt; ({k.id.slice(-8)})
                      </option>
                    ))}
                  </select>
                )}
              </label>
            )}
            {configError && <div className="setup-error" role="alert">{configError}</div>}
            <div className="setup-btn-row">
              <button type="button" className="setup-btn-secondary" onClick={() => setStep('method')}>
                ← Back
              </button>
              <button
                type="submit"
                className="setup-btn-primary"
                disabled={configuring || (method === 'gpg' && gpgKeys.length === 0)}
              >
                {configuring ? 'Setting up…' : 'Initialize Store'}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // step === 'import'
  return (
    <div className="setup-screen">
      <div className="setup-card setup-card-wide">
        <h1 className="setup-title">Import Contexts</h1>
        <p className="setup-subtitle">
          Add kubeconfig contexts to your encrypted vault. You can add more later via the Contexts menu.
        </p>

        {importedNames.length > 0 && (
          <div className="setup-imported-list">
            <strong>Imported:</strong>
            {importedNames.map((n) => (
              <span key={n} className="setup-imported-badge">{n}</span>
            ))}
          </div>
        )}

        <div className="setup-import-tabs">
          <button
            className={`setup-import-tab ${importMode === 'system' ? 'active' : ''}`}
            onClick={() => { setImportMode('system'); loadSystemContexts(); }}
            type="button"
            aria-pressed={importMode === 'system'}
          >
            From ~/.kube/config
          </button>
          <button
            className={`setup-import-tab ${importMode === 'paste' ? 'active' : ''}`}
            onClick={() => setImportMode('paste')}
            type="button"
            aria-pressed={importMode === 'paste'}
          >
            Paste YAML
          </button>
        </div>

        <form onSubmit={handleImport} className="setup-form">
          {importMode === 'system' ? (
            <label className="setup-label">
              Context
              <select
                className="setup-input"
                value={selectedSystemCtx}
                onChange={(e) => {
                  setSelectedSystemCtx(e.target.value);
                  if (!importName) setImportName(e.target.value);
                }}
              >
                <option value="">— select a context —</option>
                {systemContexts.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} ({c.cluster})
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="setup-label">
              Kubeconfig YAML
              <textarea
                className="setup-input setup-textarea"
                value={pasteYaml}
                onChange={(e) => setPasteYaml(e.target.value)}
                placeholder="Paste kubeconfig YAML here…"
                rows={8}
                spellCheck={false}
              />
            </label>
          )}

          <label className="setup-label">
            Store key (identifier)
            <input
              type="text"
              className="setup-input"
              value={importName}
              onChange={(e) => setImportName(e.target.value)}
              placeholder="e.g. prod-cluster"
            />
          </label>
          <label className="setup-label">
            Display name (optional)
            <input
              type="text"
              className="setup-input"
              value={importDisplayName}
              onChange={(e) => setImportDisplayName(e.target.value)}
              placeholder="e.g. Production Cluster"
            />
          </label>

          {importError && <div className="setup-error" role="alert">{importError}</div>}

          <div className="setup-btn-row">
            <button type="submit" className="setup-btn-primary" disabled={importing}>
              {importing ? 'Importing…' : 'Import Context'}
            </button>
            <button
              type="button"
              className="setup-btn-secondary"
              onClick={onComplete}
            >
              {importedNames.length === 0 ? 'Skip' : 'Done →'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

import type { ReactNode } from 'react';

/** Page frame: sticky top bar, scrolling content, optional sticky footer. */
export function Shell(props: { action?: ReactNode; footer?: ReactNode; children: ReactNode }) {
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Karto</span>
        {props.action}
      </header>
      <main className="content">{props.children}</main>
      {props.footer && <footer className="footer">{props.footer}</footer>}
    </div>
  );
}

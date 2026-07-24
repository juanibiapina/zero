import { Bug, Shield } from "lucide-react";

const vaultUrl = "https://dash.zeroapps.dev/vault/projects";
const errorsUrl = "https://dash.zeroapps.dev/errors/issues";
const keysUrl = "https://dash.zeroapps.dev/vault/keys";

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

export default function App() {
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="site-header">
        <a className="wordmark" href="/" aria-label="Zero home">Zero<span>.</span></a>
        <nav aria-label="Primary navigation">
          <a href="#products">Products</a>
          <a className="header-link" href={vaultUrl}>Dashboard <Arrow /></a>
        </nav>
      </header>

      <main id="main">
        <section className="hero" aria-labelledby="page-title">
          <div className="hero-copy">
            <p className="intro">For indie developers and small teams</p>
            <h1 id="page-title">One API key.<br /><span>Every Zero product.</span></h1>
            <div className="hero-actions">
              <a className="button" href={keysUrl}>Create an API key <Arrow /></a>
            </div>
          </div>
        </section>

        <section className="products" id="products" aria-label="Products">
          <div className="product-list">
            <article className="product">
              <div className="product-title">
                <p>Secrets management</p>
                <h2><Shield aria-hidden="true" />Vault</h2>
              </div>
              <div className="product-body">
                <div className="product-copy">
                  <p className="product-statement">Secrets by product and environment</p>
                  <p className="product-description">Store and update values from the dashboard or CLI.</p>
                </div>
                <a href={vaultUrl}>Open Vault <Arrow /></a>
              </div>
            </article>

            <article className="product">
              <div className="product-title">
                <p>Error reporting</p>
                <h2><Bug aria-hidden="true" />Errors</h2>
              </div>
              <div className="product-body">
                <div className="product-copy">
                  <p className="product-statement">See which failures keep happening.</p>
                  <p className="product-description">Send an HTTP report with a project name and message. Include a stack trace or context when available. Zero groups repeated failures into issues and creates the project view from the reports you send.</p>
                </div>
                <a href={errorsUrl}>Open Errors <Arrow /></a>
              </div>
            </article>
          </div>
        </section>

        <section className="closing" aria-labelledby="closing-title">
          <h2 id="closing-title">Add Zero to your projects.</h2>
          <a className="button" href={keysUrl}>Create an API key <Arrow /></a>
        </section>
      </main>

      <footer className="site-footer">
        <a className="wordmark" href="/" aria-label="Zero home">Zero<span>.</span></a>
        <a className="footer-link" href={vaultUrl}>Dashboard <Arrow /></a>
      </footer>
    </>
  );
}

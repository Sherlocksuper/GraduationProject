import { useEffect } from "react";

export default function Modal({ title, children, onClose, footer, wide }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const cardClass = wide ? "modalCard modalCard--wide" : "modalCard";

  return (
    <div className="modalRoot">
      <button type="button" className="modalBackdrop" aria-label="关闭" onClick={onClose} />
      <div className={cardClass} role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <div className="modalHead">
          <h2 id="modalTitle" className="modalTitle">
            {title}
          </h2>
          <button type="button" className="modalClose" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modalBody">{children}</div>
        {footer ? <div className="modalFoot">{footer}</div> : null}
      </div>
    </div>
  );
}

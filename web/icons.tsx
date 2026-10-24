type Name = "shelf" | "plus" | "search" | "star" | "arrow" | "edit" | "trash" | "close" | "info" | "logout" | "note" | "link";
const paths: Record<Name, string> = {
  shelf: "M4 3v18h17M9 3v13m5-11v11m5-13v13",
  plus: "M12 5v14M5 12h14",
  link: "m9 15 6-6m-5-3 2-2a5 5 0 0 1 7 7l-3 3M14 18l-2 2a5 5 0 0 1-7-7l3-3",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  star: "m12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3L2.9 9.6l6.3-.9Z",
  arrow: "M6 18 18 6M6 6h12v12", edit: "m14 5 5 5M4 20l5-1L21 7l-5-5L4 14Z",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  close: "m6 6 12 12M6 18 18 6", info: "M12 11v6m0-10v.1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  logout: "M9 4H4v16h5m7-13 5 5-5 5M9 12h12", note: "M5 3h14v18H5ZM9 8h6m-6 4h6m-6 4h4",
};
export function Icon({ name, filled = false }: { name: Name; filled?: boolean }) {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
export function Brand() { return <span className="brand"><span className="brand-mark"><Icon name="shelf" /></span>LoopShelf<span className="brand-dot">.</span></span>; }

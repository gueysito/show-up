/**
 * Dot-matrix digits with separators set in the mono face: the dot font draws
 * "." and ":" as crosses, which read as plus signs at display sizes.
 */
export function DotText({ value }: { value: string }) {
  return (
    <>
      {value.split(/([.:,])/).map((part, index) =>
        /^[.:,]$/.test(part) ? (
          <span key={index} className="dot-separator">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function OtisRing({
  small = false,
  calling = false,
}: {
  small?: boolean;
  calling?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={
        small
          ? "block size-9 rounded-full bg-(image:--otis-ring-small)"
          : calling
            ? "block size-[68px] rounded-full bg-(image:--otis-ring-calling)"
            : "block size-[68px] rounded-full bg-(image:--otis-ring)"
      }
    />
  );
}

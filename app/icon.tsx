import { ImageResponse } from "next/og"

export const size = {
  width: 512,
  height: 512,
}

export const contentType = "image/png"

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
        }}
      >
        <svg
          width="356"
          height="356"
          viewBox="0 0 512 512"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M256 74L354 118V246C354 324.8 313.9 384.8 256 418C198.1 384.8 158 324.8 158 246V118L256 74Z"
            stroke="#0D5E6B"
            strokeWidth="22"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M208 174H302" stroke="#0D5E6B" strokeWidth="18" strokeLinecap="round" />
          <path d="M208 220H286" stroke="#0D5E6B" strokeWidth="18" strokeLinecap="round" />
          <path d="M208 266H254" stroke="#0D5E6B" strokeWidth="18" strokeLinecap="round" />
          <path
            d="M214 321L247 354L310 286"
            stroke="#0D5E6B"
            strokeWidth="24"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    ),
    size
  )
}

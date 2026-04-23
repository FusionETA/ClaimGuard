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
          background: "#F7FCFB",
          borderRadius: 120,
        }}
      >
        <svg
          width="336"
          height="364"
          viewBox="0 0 512 512"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M256 76L370.667 109.333V245.067C370.667 331.467 321.333 395.467 256 428C190.667 395.467 141.333 331.467 141.333 245.067V109.333L256 76Z" fill="#E7F6F5"/>
          <path d="M256 106.667L344 132V241.734C344 305.867 309.733 355.2 256 384C202.267 355.2 168 305.867 168 241.734V132L256 106.667Z" fill="white"/>
          <path d="M256 76L370.667 109.333V245.067C370.667 331.467 321.333 395.467 256 428C190.667 395.467 141.333 331.467 141.333 245.067V109.333L256 76Z" stroke="#0D5E6B" strokeWidth="28" strokeLinejoin="round"/>
          <path d="M206.667 256L253.333 302.667L381.333 162.667" stroke="#0D5E6B" strokeWidth="34" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M214.667 176L309.333 148L382.667 170.667L330.667 118.667L256 96L182.667 118.667L177.333 217.333C177.333 291.467 214.4 348.8 256 375.333C220.267 344 192 289.6 192 228V176H214.667Z" fill="#CFECEC" fillOpacity="0.88"/>
        </svg>
      </div>
    ),
    size
  )
}

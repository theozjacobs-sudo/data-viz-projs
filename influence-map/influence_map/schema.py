from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

Kind = Literal["book", "film", "artwork", "music", "play", "poem", "other", "person"]


class Mention(BaseModel):
    """One work referenced in the body text."""

    title: str = Field(description="Title of the referenced work as commonly known, not as garbled in the text")
    creator: Optional[str] = Field(default=None, description="Author, director, painter, or composer. Null if not stated and not widely known")
    kind: Kind
    year: Optional[int] = Field(default=None, description="Year of first publication/release if widely known, else null")
    paragraph: int = Field(description="The ¶ index of the paragraph where the mention occurs")
    quote: str = Field(description="The shortest span of the paragraph (under 25 words) that contains the reference, verbatim")
    how: Literal["named", "quoted", "discussed", "alluded"] = Field(
        description="named = title simply appears; quoted = text is quoted from it; discussed = the author engages with it; alluded = clear but unnamed reference"
    )


class Person(BaseModel):
    """A creator (writer, artist, director, composer, philosopher) named without any specific work."""

    name: str = Field(description="Full name as commonly known (George Bernard Shaw, not Mr. Shaw)")
    paragraph: int
    quote: str = Field(description="Shortest span (under 25 words) containing the name, verbatim")


class ChunkResult(BaseModel):
    mentions: list[Mention]
    people: list[Person] = Field(default_factory=list, description="Creators named in the passage with no specific work attached. Skip anyone already listed as a creator in mentions")


class CanonicalWork(BaseModel):
    """A merged, deduplicated work across every raw mention in one book."""

    title: str
    creator: Optional[str] = None
    kind: Kind
    year: Optional[int] = None
    raw_titles: list[str] = Field(description="Every raw title string that maps to this work")


class CanonResult(BaseModel):
    works: list[CanonicalWork]

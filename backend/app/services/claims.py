"""Reclamo de perfiles y tutela de menores (docs/modelo-negocio.md, «Cuentas de competidor»).

* Un **adulto** reclama su propio perfil (``self``): al aprobarse, la cuenta
  queda ligada a la persona (``users.person_id``).
* Un **padre, madre o apoderado** reclama el de un menor (``parent`` o
  ``guardian``): al aprobarse se crea una tutela (``guardianships``) y se
  registra su consentimiento para publicar resultados y usar los datos en
  estadísticas (``data_consents``, Ley 29733).
* Aprueba el **dojo** de la persona (usuario con rol ``dojo_admin`` o
  ``sensei`` de ese dojo), un organizador o el Admin. Un adulto con los 4
  últimos dígitos del documento correctos puede aprobarse solo si
  ``HAJIME_AUTO_APPROVE_SELF_CLAIM`` está activo. **Los menores siempre los
  revisa una persona.**
* La búsqueda para reclamar muestra solo lo público: nombre abreviado, dojo y
  torneos. Nunca documento ni fecha de nacimiento.
"""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import dojo_admin_ids, is_staff, roles_of
from app.api.errors import Conflict, Forbidden, NotFound, TooManyRequests
from app.api.schemas_accounts import ClaimOut, ClaimReviewOut, MyProfileOut, ProfileSearchOut
from app.config import get_settings
from app.db.base import utcnow
from app.db.models import (
    DataConsent,
    Dojo,
    DojoMembership,
    Guardianship,
    IdentityDocument,
    Match,
    Person,
    PersonRole,
    ProfileClaim,
    Registration,
    Tournament,
    User,
)
from app.domain.categories import age_at
from app.domain.identity import normalize_name
from app.services import accounts, mail, people
from app.services.audit import audit
from app.services.public import short_name

ADULT_AGE = 18
CONSENT_SCOPE = "publicación de resultados y estadísticas"
# Torneos que ya ocurrieron o están en curso: los futuros no se muestran en lo público
# (no se anuncia dónde estará un menor).
PUBLIC_TOURNAMENT_STATUSES = ("in_progress", "finished")
_DAY = timedelta(days=1)
CLAIMS_PER_USER_PER_DAY = 5
DOC_CHECKS_PER_PERSON_PER_DAY = 5
RELATION_TEXT = {"self": "titular", "parent": "padre o madre", "guardian": "apoderado"}


def is_minor(p: Person, today: date | None = None) -> bool:
    """Menor de edad o sin fecha de nacimiento (ante la duda, se protege como menor)."""
    if p.birth_date is None:
        return True
    return age_at(p.birth_date, today or date.today()) < ADULT_AGE


def public_name(p: Person) -> str:
    """Nombre para lo público: abreviado («Diego R.») salvo adultos con fecha de nacimiento conocida."""
    return f"{p.first_names} {p.last_names}" if not is_minor(p) else short_name(p.first_names, p.last_names)


def by_public_id(db: Session, public_id: str) -> Person:
    p = db.scalar(select(Person).where(Person.public_id == public_id)) if public_id else None
    if p is None or p.merged_into_id is not None or p.anonymized_at is not None:
        raise NotFound("Perfil no encontrado")
    return p


def dojo_name(db: Session, person_id: int) -> tuple[int | None, str | None]:
    m = people.current_membership(db, person_id)
    if m is None:
        return None, None
    d = db.get(Dojo, m.dojo_id)
    return m.dojo_id, d.name if d else None


def _public_tournaments(db: Session, person_ids: list[int]) -> dict[int, list[str]]:
    out: dict[int, list[str]] = {pid: [] for pid in person_ids}
    if not person_ids:
        return out
    rows = db.execute(
        select(Registration.person_id, Tournament.name)
        .join(Tournament, Tournament.id == Registration.tournament_id)
        .where(
            Registration.person_id.in_(person_ids),
            Registration.status.notin_(("pending", "rejected")),  # solicitudes sin aprobar
            ~Tournament.is_test,
            Tournament.status.in_(PUBLIC_TOURNAMENT_STATUSES),
        )
        .distinct()
    ).all()
    for pid, name in rows:
        out[pid].append(name)
    return out


# ---------------------------------------------------------------------------
# Tutela y acceso
# ---------------------------------------------------------------------------


def is_guardian(db: Session, user: User, person_id: int) -> bool:
    return (
        db.scalar(select(Guardianship.id).where(Guardianship.user_id == user.id, Guardianship.person_id == person_id))
        is not None
    )


def can_see_full_profile(db: Session, user: User, person_id: int) -> bool:
    """Historial completo: la propia persona, su padre/madre/apoderado verificado, el staff
    o el administrador del dojo donde la persona tiene membresía vigente (``dojo_admin``,
    los mismos permisos sobre personas que le da ``app.api.deps``)."""
    if user.person_id == person_id or is_staff(db, user) or is_guardian(db, user, person_id):
        return True
    dojos = dojo_admin_ids(db, user)
    if not dojos:
        return False
    m = people.current_membership(db, person_id)
    return m is not None and m.dojo_id in dojos


def own_person_ids(db: Session, user: User) -> set[int]:
    """Personas cuyo detalle ve la cuenta como propio: la suya y las de los menores a cargo."""
    ids = set(db.scalars(select(Guardianship.person_id).where(Guardianship.user_id == user.id)).all())
    if user.person_id is not None:
        ids.add(user.person_id)
    return ids


def match_person_ids(db: Session, match_id: int) -> set[int]:
    """Personas que pelearon un combate: las de cada inscripción y, por equipos, las del combate individual."""
    m = db.get(Match, match_id)
    if m is None:
        raise NotFound("Combate no encontrado")
    ids = {x for x in (m.aka_person_id, m.ao_person_id) if x}
    reg_ids = [x for x in (m.aka_registration_id, m.ao_registration_id) if x]
    if reg_ids:
        ids |= {x for x in db.scalars(select(Registration.person_id).where(Registration.id.in_(reg_ids))).all() if x}
    return ids


def reviewer_dojo_ids(db: Session, user: User) -> set[int]:
    return {
        r.scope_id
        for r in roles_of(db, user)
        if r.role in ("dojo_admin", "sensei") and r.scope_type == "dojo" and r.scope_id is not None
    }


def can_review(db: Session, user: User, person_id: int) -> bool:
    if is_staff(db, user):
        return True
    dojos = reviewer_dojo_ids(db, user)
    if not dojos:
        return False
    m = people.current_membership(db, person_id)
    return m is not None and m.dojo_id in dojos


# ---------------------------------------------------------------------------
# Búsqueda para reclamar
# ---------------------------------------------------------------------------


def search(db: Session, q: str, dojo_id: int | None = None, limit: int = 20) -> list[ProfileSearchOut]:
    nq = normalize_name(q or "")
    if len(nq.replace(" ", "")) < 3:
        raise Conflict("Escribe al menos 3 letras del nombre", code="QUERY_TOO_SHORT")
    stmt = select(Person).where(Person.merged_into_id.is_(None), Person.anonymized_at.is_(None))
    for word in nq.split():
        stmt = stmt.where(Person.normalized_name.contains(word))
    if dojo_id is not None:
        stmt = stmt.join(DojoMembership, DojoMembership.person_id == Person.id).where(
            DojoMembership.dojo_id == dojo_id, DojoMembership.end_date.is_(None)
        )
    persons = list(db.scalars(stmt.order_by(Person.last_names, Person.first_names).limit(limit)).all())
    tournaments = _public_tournaments(db, [p.id for p in persons])
    out = []
    for p in persons:
        if p.public_id is None:  # pragma: no cover - la migración rellena todos
            continue
        _, dojo = dojo_name(db, p.id)
        names = tournaments.get(p.id, [])
        out.append(
            ProfileSearchOut(
                public_id=p.public_id,
                name=short_name(p.first_names, p.last_names),
                dojo=dojo,
                tournaments=sorted(names)[:5],
                tournament_count=len(names),
            )
        )
    return out


# ---------------------------------------------------------------------------
# Solicitudes
# ---------------------------------------------------------------------------


def _too_many() -> TooManyRequests:
    return TooManyRequests("Demasiadas solicitudes por hoy. Intenta mañana o consulta con tu dojo.")


def _document_match(db: Session, person_id: int, last4: str | None) -> bool | None:
    if not last4:
        return None
    numbers = db.scalars(
        select(IdentityDocument.normalized_number).where(IdentityDocument.person_id == person_id)
    ).all()
    if not numbers:
        return None
    want = last4.upper()
    return any((n or "").upper()[-4:] == want for n in numbers)


def create_claim(
    db: Session,
    user: User,
    public_id: str,
    relation: str,
    evidence: str,
    document_last4: str | None,
    consent: bool,
) -> ProfileClaim:
    if user.email_verified_at is None:
        raise Forbidden("Confirma tu correo antes de reclamar un perfil", code="EMAIL_NOT_VERIFIED")
    p = by_public_id(db, public_id)
    minor = is_minor(p)
    if relation == "self":
        if user.person_id is not None:
            raise Conflict("Tu cuenta ya está ligada a un perfil", code="ALREADY_LINKED")
        if minor and p.birth_date is not None:
            raise Conflict(
                "Es el perfil de un menor de edad: lo reclama su padre, madre o apoderado", code="MINOR_PROFILE"
            )
        if db.scalar(select(User.id).where(User.person_id == p.id)) is not None:
            raise Conflict("Este perfil ya está ligado a otra cuenta. Consulta con tu dojo.", code="PROFILE_TAKEN")
    else:
        if not minor:
            raise Conflict("Es el perfil de un adulto: lo reclama la propia persona", code="ADULT_PROFILE")
        if not consent:
            raise Conflict(
                "Para reclamar el perfil de un menor debes aceptar la publicación de sus resultados y estadísticas",
                code="CONSENT_REQUIRED",
            )
        if is_guardian(db, user, p.id):
            raise Conflict("Ya tienes este perfil a tu cargo", code="ALREADY_LINKED")
    pending = db.scalar(
        select(ProfileClaim.id).where(
            ProfileClaim.user_id == user.id, ProfileClaim.person_id == p.id, ProfileClaim.status == "pending"
        )
    )
    if pending is not None:
        raise Conflict("Ya tienes una solicitud pendiente para este perfil", code="CLAIM_PENDING")
    if not accounts.allow(db, "claim-user", str(user.id), CLAIMS_PER_USER_PER_DAY, window=_DAY):
        raise _too_many()
    match = None
    if document_last4:
        # Los 4 dígitos solo tienen 10 000 combinaciones: pocas pruebas por perfil al día.
        if not accounts.allow(db, "claim-doc", str(p.id), DOC_CHECKS_PER_PERSON_PER_DAY, window=_DAY):
            raise _too_many()
        match = _document_match(db, p.id, document_last4)
    claim = ProfileClaim(
        user_id=user.id,
        person_id=p.id,
        relation=relation,
        status="pending",
        evidence=(evidence or "").strip()[:500],
        document_match=match,
        created_at=utcnow(),
    )
    db.add(claim)
    db.flush()
    audit(
        db,
        user,
        "profile_claim",
        claim.id,
        "create",
        after={"person_id": p.id, "relationship": relation, "document_match": match},
    )
    s = get_settings()
    if relation == "self" and not minor and match is True and s.auto_approve_self_claim:
        _approve(db, None, claim, p, user, "Aprobada automáticamente: el documento coincide")
    else:
        _notify_reviewers(db, claim, p, minor)
    db.commit()
    return claim


def dojo_reviewers(db: Session, dojo_id: int) -> list[User]:
    """Cuentas activas con rol ``dojo_admin`` o ``sensei`` del dojo."""
    return list(
        db.scalars(
            select(User)
            .join(PersonRole, PersonRole.person_id == User.person_id)
            .where(
                PersonRole.role.in_(("dojo_admin", "sensei")),
                PersonRole.scope_type == "dojo",
                PersonRole.scope_id == dojo_id,
                User.is_active,
            )
            .distinct()
        ).all()
    )


def _notify_reviewers(db: Session, claim: ProfileClaim, p: Person, minor: bool) -> None:
    """Aviso por correo al dojo de la persona (dojo_admin o sensei con correo) de una solicitud nueva."""
    dojo_id, dojo = dojo_name(db, p.id)
    if dojo_id is None:
        return
    link = f"{get_settings().frontend_url()}/solicitudes"
    who = "su padre, madre o apoderado" if claim.relation != "self" else "la propia persona"
    for u in dojo_reviewers(db, dojo_id):
        if not u.email or u.id == claim.user_id:
            continue
        mail.enqueue(
            db,
            u.email,
            mail.render(
                "Nueva solicitud de perfil · Hajime",
                "Nueva solicitud de perfil",
                [
                    f"Una cuenta pide el perfil de {short_name(p.first_names, p.last_names)} ({dojo}) como {who}.",
                    "Revísala en Hajime: solo apruébala si conoces a quien la pide."
                    + (" Es un menor de edad." if minor else ""),
                ],
                ("Revisar solicitudes", link),
            ),
            kind="claim_new",
        )


def _approve(db: Session, reviewer: User | None, claim: ProfileClaim, p: Person, claimant: User, reason: str) -> None:
    now = utcnow()
    if claim.relation == "self":
        if claimant.person_id is not None and claimant.person_id != p.id:
            raise Conflict("La cuenta ya está ligada a otro perfil", code="ALREADY_LINKED")
        other = db.scalar(select(User.id).where(User.person_id == p.id, User.id != claimant.id))
        if other is not None:
            raise Conflict("Este perfil ya está ligado a otra cuenta", code="PROFILE_TAKEN")
        claimant.person_id = p.id
    else:
        consent = DataConsent(
            person_id=p.id,
            given_by=(claimant.display_name or claimant.username)[:200],
            relationship_to_person=RELATION_TEXT[claim.relation],
            given_on=claim.created_at.date(),
            medium=f"cuenta Hajime (aceptación en línea, solicitud {claim.id})",
            scope=CONSENT_SCOPE,
        )
        db.add(consent)
        db.flush()
        claim.consent_id = consent.id
        if not is_guardian(db, claimant, p.id):
            db.add(
                Guardianship(
                    user_id=claimant.id, person_id=p.id, relation=claim.relation, claim_id=claim.id, verified_at=now
                )
            )
    claim.status = "approved"
    claim.reviewed_by_id = reviewer.id if reviewer else None
    claim.reviewed_at = now
    claim.reason = reason or None
    audit(db, reviewer, "profile_claim", claim.id, "approve", after={"person_id": p.id, "user_id": claimant.id})
    _notify(db, claimant, claim, p)


def _notify(db: Session, user: User, claim: ProfileClaim, p: Person) -> None:
    if claim.status == "approved":
        from app.services import push

        push.notify_users(
            db,
            [user.id],
            "claim",
            f"claim:{claim.id}",
            "Perfil aprobado",
            f"Ya ves el historial de {public_name(p)}. Toca «Avisarme» para seguir sus combates.",
            "/mis-perfiles",
        )
    if not user.email:
        return
    base = get_settings().frontend_url()
    name = f"{p.first_names} {p.last_names}"
    if claim.status == "approved":
        paragraphs = [
            f"Tu solicitud para el perfil de {name} fue aprobada.",
            "Ya puedes ver el historial completo, las estadísticas y las insignias en Hajime.",
        ]
        action = ("Ver mis perfiles", f"{base}/mis-perfiles")
        title = "Solicitud aprobada"
    else:
        paragraphs = [f"Tu solicitud para el perfil de {name} no fue aprobada."]
        if claim.reason:
            paragraphs.append(f"Motivo: {claim.reason}")
        paragraphs.append("Si crees que es un error, consulta con tu dojo o con la organización.")
        action = None
        title = "Solicitud no aprobada"
    mail.enqueue(db, user.email, mail.render(f"{title} · Hajime", title, paragraphs, action), kind="claim_decision")


def review_claim(db: Session, reviewer: User, claim_id: int, approve: bool, reason: str | None) -> ProfileClaim:
    claim = db.get(ProfileClaim, claim_id)
    if claim is None:
        raise NotFound("Solicitud no encontrada")
    if not can_review(db, reviewer, claim.person_id):
        raise Forbidden("Solo el dojo de la persona, un organizador o el Admin revisan esta solicitud")
    if claim.status != "pending":
        raise Conflict("La solicitud ya fue revisada", code="ALREADY_REVIEWED")
    p = people.get_person(db, claim.person_id)
    claimant = db.get(User, claim.user_id)
    if claimant is None or not claimant.is_active:
        raise Conflict("La cuenta que pidió el perfil ya no está activa")
    if approve:
        _approve(db, reviewer, claim, p, claimant, reason or "")
    else:
        claim.status = "rejected"
        claim.reviewed_by_id = reviewer.id
        claim.reviewed_at = utcnow()
        claim.reason = (reason or "").strip() or None
        audit(db, reviewer, "profile_claim", claim.id, "reject", reason=claim.reason)
        _notify(db, claimant, claim, p)
    db.commit()
    return claim


def _claim_out(db: Session, c: ProfileClaim, p: Person) -> ClaimOut:
    _, dojo = dojo_name(db, p.id)
    return ClaimOut(
        id=c.id,
        status=c.status,
        relationship=c.relation,
        created_at=c.created_at,
        reviewed_at=c.reviewed_at,
        reason=c.reason,
        public_id=p.public_id,
        person_name=short_name(p.first_names, p.last_names),
        dojo=dojo,
    )


def my_claims(db: Session, user: User) -> list[ClaimOut]:
    rows = db.execute(
        select(ProfileClaim, Person)
        .join(Person, Person.id == ProfileClaim.person_id)
        .where(ProfileClaim.user_id == user.id)
        .order_by(ProfileClaim.created_at.desc())
    ).all()
    return [_claim_out(db, c, p) for c, p in rows]


def claims_to_review(db: Session, reviewer: User, status: str | None = "pending") -> list[ClaimReviewOut]:
    stmt = (
        select(ProfileClaim, Person, User)
        .join(Person, Person.id == ProfileClaim.person_id)
        .join(User, User.id == ProfileClaim.user_id)
        .order_by(ProfileClaim.created_at)
    )
    if status:
        stmt = stmt.where(ProfileClaim.status == status)
    staff = is_staff(db, reviewer)
    dojos = set() if staff else reviewer_dojo_ids(db, reviewer)
    if not staff and not dojos:
        raise Forbidden("Solo el dojo, los organizadores o el Admin revisan solicitudes")
    out = []
    for c, p, u in db.execute(stmt).all():
        dojo_id, dojo = dojo_name(db, p.id)
        if not staff and dojo_id not in dojos:
            continue
        base = _claim_out(db, c, p)
        out.append(
            ClaimReviewOut(
                **base.model_dump(exclude={"person_name"}),
                person_name=f"{p.first_names} {p.last_names}",
                person_id=p.id,
                user_id=u.id,
                user_name=u.display_name or u.username,
                user_email=u.email,
                evidence=c.evidence,
                document_match=c.document_match,
                is_minor=is_minor(p),
                # Fecha de nacimiento: solo quien ya puede verla (Admin y organizadores).
                birth_date=p.birth_date if staff else None,
            )
        )
    return out


def pending_count(db: Session, reviewer: User) -> int:
    if is_staff(db, reviewer):
        return db.scalar(select(func.count()).select_from(ProfileClaim).where(ProfileClaim.status == "pending")) or 0
    if not reviewer_dojo_ids(db, reviewer):
        return 0
    return len(claims_to_review(db, reviewer))


# ---------------------------------------------------------------------------
# Perfiles de la cuenta
# ---------------------------------------------------------------------------


def my_profiles(db: Session, user: User) -> list[MyProfileOut]:
    out = []
    if user.person_id is not None:
        p = db.get(Person, user.person_id)
        if p is not None:
            _, dojo = dojo_name(db, p.id)
            out.append(
                MyProfileOut(
                    person_id=p.id,
                    public_id=p.public_id,
                    name=f"{p.first_names} {p.last_names}",
                    relationship="self",
                    dojo=dojo,
                )
            )
    rows = db.execute(
        select(Guardianship, Person)
        .join(Person, Person.id == Guardianship.person_id)
        .where(Guardianship.user_id == user.id)
        .order_by(Person.first_names)
    ).all()
    for g, p in rows:
        _, dojo = dojo_name(db, p.id)
        out.append(
            MyProfileOut(
                person_id=p.id,
                public_id=p.public_id,
                name=f"{p.first_names} {p.last_names}",
                relationship=g.relation,
                dojo=dojo,
                guardianship_id=g.id,
            )
        )
    return out


def remove_guardianship(db: Session, user: User, guardianship_id: int) -> None:
    g = db.get(Guardianship, guardianship_id)
    if g is None or (g.user_id != user.id and not is_staff(db, user)):
        raise NotFound("No encontrado")
    audit(db, user, "guardianship", g.id, "remove", before={"user_id": g.user_id, "person_id": g.person_id})
    db.delete(g)
    db.commit()
